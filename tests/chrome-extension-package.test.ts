import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const root = join(import.meta.dir, "..", "chrome-extension");

async function inspectContentScript(
  html: string,
  options: {
    afterDispatch?: (document: Document) => void;
    message?: unknown;
  } = {},
): Promise<unknown> {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument(`<body>${html}</body>`);
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
      if (command === "insertText") selectedNode.textContent = value ?? "";
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
        sendMessage: async () => undefined,
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
    location: new URL("https://chatgpt.com/?temporary-chat=true"),
    URL,
    clearInterval: () => undefined,
    clearTimeout,
    setInterval: () => 1,
    setTimeout,
  });
  expect(listener).toBeDefined();
  return await new Promise(resolve => {
    listener?.(options.message ?? { type: "inspect_session" }, {}, resolve);
    options.afterDispatch?.(document);
  });
}

test("Chrome extension manifest has only the required site and Native Messaging access", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(["nativeMessaging"]);
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
