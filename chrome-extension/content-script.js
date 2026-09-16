const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
].join(", ");
const ASSISTANT_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
].join(", ");
const STOP_SELECTOR = '[data-testid="stop-button"]';
const COMPLETE_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
let active;

function visible(element) {
  return element instanceof HTMLElement
    && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden";
}

function describeElement(element) {
  const attribute = name => {
    const value = element.getAttribute(name);
    return value === null ? "" : `[${name}=${JSON.stringify(value.slice(0, 80))}]`;
  };
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`
    + attribute("data-testid")
    + attribute("contenteditable")
    + attribute("data-lexical-editor")
    + attribute("aria-hidden")
    + attribute("role");
}

function exactVisible(selector) {
  const matches = [...document.querySelectorAll(selector)].filter(visible);
  const leaves = matches.filter(candidate => !matches.some(other => other !== candidate && candidate.contains(other)));
  if (leaves.length !== 1) {
    const error = new Error(`ChatGPT structure is ambiguous for ${selector}: ${leaves.map(describeElement).join(", ")}`);
    error.retryable = leaves.length === 0;
    throw error;
  }
  return leaves[0];
}

function emit(identity, type, fields = {}) {
  void chrome.runtime.sendMessage({
    source: "codex-chatgpt-web-content",
    event: { version: 1, type, ...identity, ...fields },
  });
}

function inspectSession() {
  try {
    if (location.hostname !== "chatgpt.com" || location.pathname.startsWith("/auth")) {
      return { authenticated: false, temporary: false, url: location.href, error: "ChatGPT login is required" };
    }
    exactVisible(COMPOSER_SELECTOR);
    const temporary = new URL(location.href).searchParams.has("temporary-chat");
    return {
      authenticated: true,
      temporary,
      url: location.href,
      ...(temporary ? {} : { error: "The dedicated tab is not a Temporary Chat" }),
    };
  } catch (error) {
    return {
      authenticated: false,
      temporary: false,
      url: location.href,
      error: error.message,
      retryable: error?.retryable === true,
    };
  }
}

async function inspectSessionWhenReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const session = inspectSession();
    if (!session.retryable || Date.now() >= deadline) {
      const { retryable: _retryable, ...result } = session;
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function assistantIdentity(element) {
  return element.getAttribute("data-turn-id")
    || element.getAttribute("data-testid")
    || element.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container");
}

function currentAssistant(baseline) {
  const candidates = [...document.querySelectorAll(ASSISTANT_SELECTOR)]
    .filter(visible)
    .filter(element => {
      const identity = assistantIdentity(element);
      return identity && !baseline.has(identity);
    });
  if (candidates.length > 1) throw new Error("ChatGPT exposed multiple new assistant turns");
  return candidates[0];
}

function answerText(element) {
  const markdown = [...element.querySelectorAll(".markdown")].filter(visible);
  const source = markdown.length === 1 ? markdown[0] : markdown.length === 0 ? element : undefined;
  if (!source) throw new Error("ChatGPT answer structure is ambiguous");
  return source.innerText.trim();
}

function stopObservation() {
  if (!active) return;
  clearInterval(active.timer);
  active = undefined;
}

function observeAnswer(identity, baseline) {
  let started = false;
  let emitted = "";
  const timer = setInterval(() => {
    try {
      const session = inspectSession();
      if (!session.authenticated) {
        emit(identity, "logged_out", { error: session.error || "ChatGPT login is required" });
        stopObservation();
        return;
      }
      const assistant = currentAssistant(baseline);
      const running = [...document.querySelectorAll(STOP_SELECTOR)].filter(visible).length;
      if (running > 1) throw new Error("ChatGPT exposed multiple stop controls");
      if (!started && (assistant || running === 1)) {
        started = true;
        emit(identity, "answer_started");
      }
      if (!assistant) return;
      const text = answerText(assistant);
      if (!text.startsWith(emitted)) throw new Error("ChatGPT rewrote already emitted answer text");
      if (text !== emitted) {
        emitted = text;
        emit(identity, "answer_delta", { text });
      }
      const completeActions = [...assistant.querySelectorAll(COMPLETE_SELECTOR)].filter(visible);
      if (completeActions.length > 1) throw new Error("ChatGPT completion structure is ambiguous");
      if (running === 0 && completeActions.length === 1 && text) {
        emit(identity, "answer_complete", { text });
        stopObservation();
      }
    } catch (error) {
      emit(identity, "structure_error", { error: error.message });
      stopObservation();
    }
  }, 200);
  active = { identity, timer };
}

function insertExactPrompt(composer, text) {
  composer.focus();
  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand("delete", false);
  document.execCommand("insertText", false, text);
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  if (composer.textContent !== text) throw new Error("ChatGPT composer did not preserve the exact prompt");
}

async function sendText(message) {
  if (active) throw new Error("This dedicated ChatGPT tab already has a running Codex request");
  const session = await inspectSessionWhenReady();
  if (!session.authenticated || !session.temporary) throw new Error(session.error || "ChatGPT login is required");
  const baseline = new Set([...document.querySelectorAll(ASSISTANT_SELECTOR)].map(assistantIdentity).filter(Boolean));
  const composer = exactVisible(COMPOSER_SELECTOR);
  insertExactPrompt(composer, message.text);
  const send = exactVisible('button[data-testid="send-button"]');
  if (send.disabled || send.getAttribute("aria-disabled") === "true") {
    throw new Error("ChatGPT send control is disabled");
  }
  send.click();
  observeAnswer(message.identity, baseline);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message?.type === "inspect_session") return await inspectSessionWhenReady();
      if (message?.type === "task_health") {
        const session = inspectSession();
        return { healthy: session.authenticated && session.temporary };
      }
      if (message?.type === "cancel_answer") {
        if (!active) return { ok: true };
        const stops = [...document.querySelectorAll(STOP_SELECTOR)].filter(visible);
        if (stops.length !== 1) throw new Error("ChatGPT cancel control is unavailable or ambiguous");
        stops[0].click();
        stopObservation();
        return { ok: true };
      }
      if (message?.type === "send_text" && typeof message.text === "string") return await sendText(message);
      throw new Error("Unsupported ChatGPT content command");
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })().then(sendResponse);
  return true;
});
