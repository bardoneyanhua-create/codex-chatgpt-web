import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const root = join(import.meta.dir, "..", "chrome-extension");

function runServiceWorker(
  session: Record<string, unknown>,
  tabs: Map<number, { id: number; url: string; pendingUrl?: string }>,
) {
  const posted: unknown[] = [];
  let nativeListener: ((message: unknown) => void) | undefined;
  let updatedListener: ((tabId: number, changeInfo: { status?: string }) => void) | undefined;
  let nextTab = Math.max(0, ...tabs.keys()) + 1;
  const event = () => ({ addListener() {} });
  const port = {
    onMessage: { addListener(listener: typeof nativeListener) { nativeListener = listener; } },
    onDisconnect: event(),
    postMessage(message: unknown) { posted.push(message); },
  };
  runInNewContext(readFileSync(join(root, "service-worker.js"), "utf8"), {
    chrome: {
      runtime: { connectNative: () => port, onMessage: event() },
      storage: {
        session: {
          async get(key: string) { return { [key]: session[key] }; },
          async set(value: Record<string, unknown>) { Object.assign(session, value); },
        },
      },
      tabs: {
        async create({ url }: { url: string }) {
          const tab = { id: nextTab++, url: "about:blank", pendingUrl: url };
          tabs.set(tab.id, tab);
          return tab;
        },
        async get(tabId: number) {
          const tab = tabs.get(tabId);
          if (!tab) throw new Error("missing tab");
          return tab;
        },
        async sendMessage() { return { ok: true }; },
        async remove(tabId: number) { tabs.delete(tabId); },
        onRemoved: event(),
        onUpdated: { addListener(listener: typeof updatedListener) { updatedListener = listener; } },
      },
    },
    URL,
    clearTimeout,
    setTimeout,
  });
  return {
    dispatch(message: unknown) { nativeListener?.(message); },
    posted,
    update(tabId: number, changeInfo: { status?: string }) { updatedListener?.(tabId, changeInfo); },
  };
}

async function inspectContentScript(
  html: string,
  options: {
    afterDispatch?: (document: Document) => void;
    intervalScenario?: (tick: () => void, document: Document) => void;
    message?: unknown;
    sentMessages?: unknown[];
    transformInsertedText?: (node: Element, value: string) => void;
  } = {},
): Promise<unknown> {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument(`<body>${html}</body>`);
  document.addEventListener("click", event => {
    const target = event.target as Element | null;
    if (target?.getAttribute?.("data-testid") !== "send-button") return;
    const composer = document.querySelector("#prompt-textarea");
    if (composer) composer.textContent = "";
  });
  for (const element of document.querySelectorAll("*")) {
    Object.defineProperty(element, "getClientRects", { value: () => [{}] });
  }
  let selectedNode: Element | undefined;
  Object.defineProperty(document, "createRange", {
    value: () => ({ selectNodeContents(node: Element) { selectedNode = node; } }),
  });
  Object.defineProperty(document, "execCommand", {
    value: (command: string, _showUi: boolean, value?: string) => {
      if (!selectedNode) return false;
      if (command === "delete") selectedNode.textContent = "";
      if (command === "insertText") {
        if (options.transformInsertedText) options.transformInsertedText(selectedNode, value ?? "");
        else selectedNode.textContent = value ?? "";
      }
      return true;
    },
  });
  let listener: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean) | undefined;
  function HTMLElement() {}
  Object.defineProperty(HTMLElement, Symbol.hasInstance, {
    value: (value: unknown) => typeof (value as { getClientRects?: unknown })?.getClientRects === "function",
  });
  runInNewContext(readFileSync(join(root, "content-script.js"), "utf8"), {
    chrome: {
      runtime: {
        onMessage: { addListener(value: typeof listener) { listener = value; } },
        sendMessage: async (message: unknown) => { options.sentMessages?.push(message); },
      },
    },
    document,
    getComputedStyle: () => ({ visibility: "visible" }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    HTMLElement,
    InputEvent: class InputEvent {
      constructor(type: string, init?: { bubbles?: boolean }) {
        const event = document.createEvent("Event");
        event.initEvent(type, init?.bubbles ?? false, false);
        return event;
      }
    },
    KeyboardEvent: class KeyboardEvent {
      constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean }) {
        const event = document.createEvent("Event");
        event.initEvent(type, init?.bubbles ?? false, init?.cancelable ?? false);
        return event;
      }
    },
    location: new URL("https://chatgpt.com/?temporary-chat=true"),
    URL,
    clearInterval: () => undefined,
    clearTimeout,
    setInterval: (tick: () => void) => {
      options.intervalScenario?.(tick, document);
      return 1;
    },
    setTimeout,
  });
  expect(listener).toBeDefined();
  return await new Promise(resolve => {
    listener?.(options.message ?? { type: "inspect_session" }, {}, resolve);
    options.afterDispatch?.(document);
  });
}

test("Chrome extension manifest has only the required site, Native Messaging, and session storage access", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(["nativeMessaging", "storage"]);
  expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*"]);
  expect(JSON.stringify(manifest)).not.toContain("cookies");
  expect(JSON.stringify(manifest)).not.toContain("history");
  expect(JSON.stringify(manifest)).not.toContain("debugger");
  expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
});

test("extension sources never select the active tab or read cookies", () => {
  const source = ["service-worker.js", "content-script.js"]
    .map(file => readFileSync(join(root, file), "utf8"))
    .join("\n");
  expect(source).not.toContain("active: true");
  expect(source).not.toContain("chrome.cookies");
  expect(source).not.toContain("chrome.debugger");
  expect(source).not.toContain("chrome.history");
  expect(source).not.toContain("currentWindow");
});

test("service worker restores exact task ownership after a worker restart", async () => {
  const session: Record<string, unknown> = {};
  const tabs = new Map<number, { id: number; url: string; pendingUrl?: string }>();
  const identity = { version: 1, instanceId: "instance-a", taskId: "task-a" };
  const first = runServiceWorker(session, tabs);
  first.dispatch({ ...identity, requestId: "request-create", type: "create_task" });
  await Bun.sleep(0);
  const created = first.posted[0] as { ok: boolean; tabId: number };
  expect(created).toMatchObject({ ok: true });

  const restarted = runServiceWorker(session, tabs);
  restarted.dispatch({
    ...identity,
    requestId: "request-send",
    type: "send_text",
    tabId: created.tabId,
    text: "hello",
  });
  await Bun.sleep(0);
  expect(restarted.posted[0]).toMatchObject({ type: "ack", ok: true, tabId: created.tabId });
});

test("service worker ignores the dedicated tab's initial navigation", async () => {
  const worker = runServiceWorker({}, new Map());
  const identity = { version: 1, instanceId: "instance-a", taskId: "task-a" };
  worker.dispatch({ ...identity, requestId: "request-create", type: "create_task" });
  await Bun.sleep(0);
  const created = worker.posted[0] as { tabId: number };
  worker.posted.length = 0;

  worker.update(created.tabId, { status: "loading" });
  await Bun.sleep(0);

  expect(worker.posted).toEqual([]);
});

test("content script treats nested composer aliases as one visible composer", async () => {
  const result = await inspectContentScript(`
    <div data-testid="prompt-textarea">
      <div id="prompt-textarea" contenteditable="true" data-lexical-editor="true"></div>
    </div>
  `);
  expect(result).toMatchObject({ authenticated: true, temporary: true });
});

test("content script describes distinct ambiguous composer candidates", async () => {
  const result = await inspectContentScript(`
    <div data-testid="prompt-textarea" id="composer-a"></div>
    <div data-testid="prompt-textarea" id="composer-b"></div>
  `);
  expect(result).toMatchObject({
    authenticated: false,
  });
  const error = (result as { error: string }).error;
  expect(error).toContain("div#composer-a");
  expect(error).toContain("div#composer-b");
});

test("content script waits for the ChatGPT composer to finish rendering", async () => {
  const result = await inspectContentScript(`<main id="surface"></main>`, {
    afterDispatch: document => {
      setTimeout(() => {
        const composer = document.createElement("div");
        composer.id = "prompt-textarea";
        composer.setAttribute("contenteditable", "true");
        Object.defineProperty(composer, "getClientRects", { value: () => [{}] });
        document.querySelector("#surface")?.appendChild(composer);
      }, 10);
    },
  });
  expect(result).toMatchObject({ authenticated: true, temporary: true });
});

test("content script waits for the composer before sending the first task prompt", async () => {
  const result = await inspectContentScript(`<main id="surface"></main>`, {
    message: { type: "send_text", identity: {}, text: "hello" },
    afterDispatch: document => {
      setTimeout(() => {
        const composer = document.createElement("div");
        composer.id = "prompt-textarea";
        composer.setAttribute("contenteditable", "true");
        Object.defineProperty(composer, "getClientRects", { value: () => [{}] });
        Object.defineProperty(composer, "focus", { value: () => undefined });
        const send = document.createElement("button");
        send.setAttribute("data-testid", "send-button");
        Object.defineProperty(send, "getClientRects", { value: () => [{}] });
        const surface = document.querySelector("#surface");
        surface?.appendChild(composer);
        surface?.appendChild(send);
      }, 10);
    },
  });
  expect(result).toMatchObject({ ok: true });
});

test("content script verifies multiline Lexical text through rendered plain text", async () => {
  const prompt = "first line\nsecond line";
  const result = await inspectContentScript(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button"></button>
  `, {
    message: { type: "send_text", identity: {}, text: prompt },
    transformInsertedText: (composer, value) => {
      composer.textContent = value.replaceAll("\n", "");
      Object.defineProperty(composer, "innerText", {
        get: () => composer.textContent === "" ? "" : value,
      });
      Object.defineProperty(composer, "focus", { value: () => undefined });
    },
  });
  expect(result).toMatchObject({ ok: true });
});

test("content script waits for React to enable the exact send control", async () => {
  const result = await inspectContentScript(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button" disabled></button>
  `, {
    message: { type: "send_text", identity: {}, text: "hello" },
    afterDispatch: document => {
      Object.defineProperty(document.querySelector("#prompt-textarea"), "focus", { value: () => undefined });
      setTimeout(() => document.querySelector('[data-testid="send-button"]')?.removeAttribute("disabled"), 10);
    },
  });
  expect(result).toMatchObject({ ok: true });
});

test("content script uses the exact composer form when a synthetic button click is ignored", async () => {
  let submitted = false;
  const result = await inspectContentScript(`
    <form id="composer-form">
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button"></button>
    </form>
  `, {
    message: { type: "send_text", identity: {}, text: "hello" },
    afterDispatch: document => {
      const composer = document.querySelector("#prompt-textarea")!;
      const send = document.querySelector('[data-testid="send-button"]')!;
      const form = document.querySelector("#composer-form")!;
      Object.defineProperty(composer, "focus", { value: () => undefined });
      Object.defineProperty(send, "click", { value: () => undefined });
      Object.defineProperty(form, "requestSubmit", {
        value: () => {
          submitted = true;
          composer.textContent = "";
        },
      });
    },
  });
  expect(result).toMatchObject({ ok: true });
  expect(submitted).toBeTrue();
});

test("content script falls back to the exact composer's Enter handler when click is ignored", async () => {
  let enterDispatched = false;
  const result = await inspectContentScript(`
    <form id="composer-form">
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button"></button>
    </form>
  `, {
    message: { type: "send_text", identity: {}, text: "hello" },
    afterDispatch: document => {
      const composer = document.querySelector("#prompt-textarea")!;
      const send = document.querySelector('[data-testid="send-button"]')!;
      const form = document.querySelector("#composer-form")!;
      Object.defineProperty(composer, "focus", { value: () => undefined });
      Object.defineProperty(send, "click", { value: () => undefined });
      Object.defineProperty(form, "requestSubmit", { value: () => undefined });
      composer.addEventListener("keydown", () => {
        enterDispatched = true;
        composer.textContent = "";
      });
    },
  });
  expect(result).toMatchObject({ ok: true });
  expect(enterDispatched).toBeTrue();
});

test("content script fails closed when ChatGPT never accepts the exact prompt", async () => {
  const result = await inspectContentScript(`
    <form id="composer-form">
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button"></button>
    </form>
  `, {
    message: { type: "send_text", identity: {}, text: "hello" },
    afterDispatch: document => {
      const composer = document.querySelector("#prompt-textarea")!;
      const send = document.querySelector('[data-testid="send-button"]')!;
      const form = document.querySelector("#composer-form")!;
      Object.defineProperty(composer, "focus", { value: () => undefined });
      Object.defineProperty(send, "click", { value: () => undefined });
      Object.defineProperty(form, "requestSubmit", { value: () => undefined });
    },
  });
  expect(result).toMatchObject({ ok: false, error: "ChatGPT did not accept the exact prompt" });
});

test("content script withholds rewritten draft text and returns only the completed answer", async () => {
  const sentMessages: Array<{ event?: { type?: string; text?: string } }> = [];
  const result = await inspectContentScript(`
    <form>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button"></button>
    </form>
    <main id="turns"></main>
  `, {
    message: { type: "send_text", identity: {}, text: "hello" },
    sentMessages,
    afterDispatch: document => {
      Object.defineProperty(document.querySelector("#prompt-textarea"), "focus", { value: () => undefined });
    },
    intervalScenario: (tick, document) => {
      let renderedText = "draft answer";
      const assistant = document.createElement("article");
      assistant.setAttribute("data-testid", "conversation-turn-1");
      assistant.setAttribute("data-message-author-role", "assistant");
      assistant.setAttribute("data-turn-id", "turn-1");
      assistant.textContent = "draft answer";
      Object.defineProperty(assistant, "innerText", { get: () => renderedText });
      Object.defineProperty(assistant, "getClientRects", { value: () => [{}] });
      const stop = document.createElement("button");
      stop.setAttribute("data-testid", "stop-button");
      Object.defineProperty(stop, "getClientRects", { value: () => [{}] });
      document.querySelector("#turns")?.appendChild(assistant);
      document.querySelector("#turns")?.appendChild(stop);
      tick();
      renderedText = "final answer";
      assistant.textContent = "final answer";
      stop.remove();
      const copy = document.createElement("button");
      copy.setAttribute("data-testid", "copy-turn-action-button");
      Object.defineProperty(copy, "getClientRects", { value: () => [{}] });
      assistant.appendChild(copy);
      tick();
    },
  });
  expect(result).toMatchObject({ ok: true });
  await Bun.sleep(20);
  expect(sentMessages.some(message => message.event?.type === "answer_delta")).toBeFalse();
  expect(sentMessages.find(message => message.event?.type === "answer_complete")?.event?.text)
    .toBe("final answer");
});
