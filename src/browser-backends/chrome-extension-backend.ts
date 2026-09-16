import { createHash, randomUUID } from "node:crypto";
import type { BrowserTurn } from "../adapters/chatgpt-web/browser-worker";
import type { CodexProviderConfig } from "../types";
import { ChromeNativeMessagingTransport } from "../chrome-extension/bridge-transport";
import type {
  ChromeBridgeEvent,
  ChromeBridgeRequest,
  ChromeBridgeResponse,
} from "../chrome-extension/protocol";
import {
  assertChromeBridgeIdentity,
  CHROME_EXTENSION_PROTOCOL_VERSION,
} from "../chrome-extension/protocol";
import type { BrowserBackend, BrowserSessionInspection } from "./types";

export interface ChromeExtensionTransport {
  request(request: ChromeBridgeRequest): Promise<ChromeBridgeResponse>;
  subscribe(listener: (event: ChromeBridgeEvent) => void): () => void;
  close(): Promise<void>;
}

interface ActiveTurn {
  request: ChromeBridgeRequest & { type: "send_text"; tabId: number };
  turn: BrowserTurn;
  text: string;
  resolve(value: string): void;
  reject(error: Error): void;
}

function unavailable(message: string): Error {
  return new Error(`ChatGPT Web backend unavailable: ${message}`);
}

export class ChromeExtensionBackend implements BrowserBackend {
  readonly kind = "chrome-extension" as const;
  private readonly taskTabs = new Map<string, number>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly unsubscribe: () => void;

  static forProvider(provider: CodexProviderConfig): ChromeExtensionBackend {
    const configured = provider.chatgptWeb ?? {};
    const extensionId = configured.chromeExtensionId?.trim();
    const pipePath = configured.chromeExtensionPipePath?.trim();
    if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
      throw new Error("Chrome Extension Backend requires a valid chromeExtensionId");
    }
    if (!pipePath) throw new Error("Chrome Extension Backend requires chromeExtensionPipePath");
    const instanceId = configured.chromeExtensionInstanceId?.trim()
      || createHash("sha256").update(`${provider.baseUrl}:${pipePath}`).digest("hex").slice(0, 32);
    return new ChromeExtensionBackend({
      instanceId,
      transport: new ChromeNativeMessagingTransport({ pipePath }),
    });
  }

  constructor(private readonly options: {
    instanceId: string;
    transport: ChromeExtensionTransport;
  }) {
    this.unsubscribe = options.transport.subscribe(event => this.onEvent(event));
  }

  async run(turn: BrowserTurn): Promise<string> {
    const taskId = turn.conversationKey?.trim() || turn.traceId;
    const requestId = `${turn.traceId}:${randomUUID().replaceAll("-", "")}`;
    const base = {
      version: CHROME_EXTENSION_PROTOCOL_VERSION,
      instanceId: this.options.instanceId,
      taskId,
      requestId,
    } as const;
    assertChromeBridgeIdentity(base);

    const existingTab = this.taskTabs.get(taskId);
    let tabId = existingTab;
    if (tabId === undefined) {
      const created = await this.options.transport.request({ ...base, type: "create_task" });
      if (!created.ok || created.type !== "task_created" || created.tabId === undefined) {
        throw unavailable(created.error || "the extension did not create a dedicated ChatGPT tab");
      }
      tabId = created.tabId;
      this.taskTabs.set(taskId, tabId);
    }

    const prepared = await turn.prepare();
    if (prepared.images.length > 0) {
      prepared.release();
      throw unavailable("Chrome Extension Backend MVP does not support image input");
    }
    await turn.onPreparedSelected?.(existingTab !== undefined);

    const request: ActiveTurn["request"] = {
      ...base,
      type: "send_text",
      tabId,
      text: prepared.text,
    };
    let abortListener: (() => void) | undefined;
    try {
      const completion = new Promise<string>((resolve, reject) => {
        this.active.set(requestId, { request, turn, text: "", resolve, reject });
      });
      abortListener = () => {
        const active = this.active.get(requestId);
        if (!active) return;
        this.active.delete(requestId);
        active.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
        void this.options.transport.request({ ...base, type: "cancel_answer", tabId }).catch(() => {});
      };
      turn.abortSignal?.addEventListener("abort", abortListener, { once: true });
      if (turn.abortSignal?.aborted) abortListener();
      else {
        const accepted = await this.options.transport.request(request);
        if (!accepted.ok) {
          this.active.delete(requestId);
          throw unavailable(accepted.error || "the extension rejected the prompt");
        }
        await turn.onSendActivated?.();
      }
      return await completion;
    } finally {
      if (abortListener) turn.abortSignal?.removeEventListener("abort", abortListener);
      this.active.delete(requestId);
      prepared.release();
      if (!turn.retainConversation) {
        this.taskTabs.delete(taskId);
        await this.options.transport.request({ ...base, type: "close_task", tabId }).catch(() => {});
      }
    }
  }

  async inspectSession(_detectCapabilities: boolean): Promise<BrowserSessionInspection> {
    const request: ChromeBridgeRequest = {
      version: CHROME_EXTENSION_PROTOCOL_VERSION,
      instanceId: this.options.instanceId,
      taskId: "session",
      requestId: `inspect:${randomUUID().replaceAll("-", "")}`,
      type: "inspect_session",
    };
    const response = await this.options.transport.request(request);
    if (!response.ok || response.type !== "session" || response.authenticated !== true
      || response.temporary !== true || typeof response.url !== "string") {
      throw unavailable(response.error || "the extension could not prove an authenticated ChatGPT session");
    }
    return { authenticated: true, temporary: true, url: response.url };
  }

  async smokeTest(_abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    throw unavailable("run a normal Codex turn to test the Chrome Extension Backend MVP");
  }

  async close(): Promise<void> {
    this.unsubscribe();
    for (const active of this.active.values()) active.reject(unavailable("the local bridge stopped"));
    this.active.clear();
    this.taskTabs.clear();
    await this.options.transport.close();
  }

  private onEvent(event: ChromeBridgeEvent): void {
    try { assertChromeBridgeIdentity(event); }
    catch { return; }
    const active = this.active.get(event.requestId);
    if (!active) return;
    const expected = active.request;
    if (event.instanceId !== expected.instanceId || event.taskId !== expected.taskId
      || event.tabId !== expected.tabId) return;

    if (event.type === "answer_started") {
      active.turn.onSubmitted?.();
      return;
    }
    if (event.type === "answer_delta" || event.type === "answer_complete") {
      const snapshot = event.text;
      if (typeof snapshot !== "string" || !snapshot.startsWith(active.text)) {
        this.active.delete(event.requestId);
        active.reject(unavailable("ChatGPT rewrote already streamed answer text; refusing ambiguous output"));
        return;
      }
      const delta = snapshot.slice(active.text.length);
      if (delta) active.turn.onTextDelta(delta);
      active.text = snapshot;
      if (event.type === "answer_complete") {
        this.active.delete(event.requestId);
        active.resolve(snapshot);
      }
      return;
    }
    if (event.type === "page_closed") this.taskTabs.delete(event.taskId);
    this.active.delete(event.requestId);
    const detail = event.error || event.type.replaceAll("_", " ");
    active.reject(unavailable(`the dedicated ChatGPT tab ${detail}`));
  }
}
