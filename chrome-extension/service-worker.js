const HOST_NAME = "com.bardoneyanhua.codex_chatgpt_web";
const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const bindings = new Map();
let nativePort;
let reconnectTimer;

function keyOf(identity) {
  return `${identity.instanceId}:${identity.taskId}`;
}

function validIdentity(message, requireTab = false) {
  const text = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
  return message?.version === 1
    && text(message.instanceId)
    && text(message.taskId)
    && text(message.requestId)
    && (!requireTab || (Number.isSafeInteger(message.tabId) && message.tabId >= 0));
}

function post(message) {
  try { nativePort?.postMessage(message); }
  catch { scheduleReconnect(); }
}

function response(request, type, fields = {}) {
  post({
    version: 1,
    type,
    instanceId: request.instanceId,
    taskId: request.taskId,
    requestId: request.requestId,
    ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
    ...fields,
  });
}

function scheduleReconnect() {
  nativePort = undefined;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectNative, 2_000);
}

function connectNative() {
  clearTimeout(reconnectTimer);
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    nativePort.onMessage.addListener(message => { void handleNativeRequest(message); });
    nativePort.onDisconnect.addListener(scheduleReconnect);
  } catch {
    scheduleReconnect();
  }
}

async function tabExists(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return typeof tab.url === "string" && new URL(tab.url).hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

async function sendToContent(tabId, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await chrome.tabs.sendMessage(tabId, message); }
    catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error(lastError?.message || "ChatGPT content script did not become ready");
}

async function createDedicatedTab(request) {
  const bindingKey = keyOf(request);
  const existing = bindings.get(bindingKey);
  if (existing && await tabExists(existing.tabId)) {
    existing.requestId = request.requestId;
    return existing.tabId;
  }
  if (existing) bindings.delete(bindingKey);
  const tab = await chrome.tabs.create({ url: TEMPORARY_CHAT_URL, active: false });
  if (!Number.isSafeInteger(tab.id)) throw new Error("Chrome did not assign a tab id");
  bindings.set(bindingKey, {
    instanceId: request.instanceId,
    taskId: request.taskId,
    requestId: request.requestId,
    tabId: tab.id,
  });
  return tab.id;
}

async function handleNativeRequest(request) {
  if (!validIdentity(request)) return;
  try {
    if (request.type === "create_task") {
      const tabId = await createDedicatedTab(request);
      response({ ...request, tabId }, "task_created", { ok: true });
      return;
    }
    if (request.type === "inspect_session") {
      const tab = await chrome.tabs.create({ url: TEMPORARY_CHAT_URL, active: false });
      if (!Number.isSafeInteger(tab.id)) throw new Error("Chrome did not assign a probe tab id");
      try {
        const result = await sendToContent(tab.id, { type: "inspect_session" });
        response(request, "session", {
          ok: result?.authenticated === true && result?.temporary === true,
          authenticated: result?.authenticated === true,
          temporary: result?.temporary === true,
          url: result?.url,
          ...(result?.error ? { error: result.error } : {}),
        });
      } finally {
        await chrome.tabs.remove(tab.id).catch(() => {});
      }
      return;
    }
    const binding = bindings.get(keyOf(request));
    if (!binding || request.tabId !== binding.tabId || !await tabExists(binding.tabId)) {
      throw new Error("No dedicated ChatGPT tab owns this exact task identity");
    }
    binding.requestId = request.requestId;
    if (request.type === "send_text") {
      const result = await sendToContent(binding.tabId, {
        type: "send_text",
        identity: { ...binding, requestId: request.requestId, version: 1 },
        text: request.text,
      });
      if (result?.ok !== true) throw new Error(result?.error || "ChatGPT page rejected the prompt");
      response(request, "ack", { ok: true });
      return;
    }
    if (request.type === "cancel_answer") {
      await sendToContent(binding.tabId, { type: "cancel_answer", identity: request });
      response(request, "ack", { ok: true });
      return;
    }
    if (request.type === "task_health") {
      const result = await sendToContent(binding.tabId, { type: "task_health" });
      response(request, "health", { ok: result?.healthy === true, healthy: result?.healthy === true });
      return;
    }
    if (request.type === "close_task") {
      bindings.delete(keyOf(request));
      await chrome.tabs.remove(binding.tabId);
      response(request, "ack", { ok: true });
      return;
    }
    throw new Error(`Unsupported Chrome extension request: ${String(request.type)}`);
  } catch (error) {
    response(request, "error", { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.source !== "codex-chatgpt-web-content" || !validIdentity(message.event, true)) return;
  const binding = bindings.get(keyOf(message.event));
  if (!binding || sender.tab?.id !== binding.tabId || message.event.tabId !== binding.tabId
    || message.event.requestId !== binding.requestId) return;
  post(message.event);
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const [bindingKey, binding] of bindings) {
    if (binding.tabId !== tabId) continue;
    bindings.delete(bindingKey);
    post({ version: 1, type: "page_closed", ...binding });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  for (const binding of bindings.values()) {
    if (binding.tabId === tabId) post({ version: 1, type: "page_reloaded", ...binding });
  }
});

connectNative();

