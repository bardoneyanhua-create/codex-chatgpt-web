import { createServer, type Server, type Socket } from "node:net";
import type { ChromeExtensionTransport } from "../browser-backends/chrome-extension-backend";
import {
  assertChromeBridgeIdentity,
  type ChromeBridgeEvent,
  type ChromeBridgeRequest,
  type ChromeBridgeResponse,
} from "./protocol";

const eventTypes = new Set<ChromeBridgeEvent["type"]>([
  "answer_started",
  "answer_delta",
  "answer_complete",
  "page_closed",
  "page_reloaded",
  "logged_out",
  "structure_error",
  "page_error",
]);

interface PendingRequest {
  resolve(value: ChromeBridgeResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ChromeNativeMessagingTransport implements ChromeExtensionTransport {
  private readonly server: Server;
  private readonly listening: Promise<void>;
  private socket?: Socket;
  private socketWaiters: Array<{ resolve(socket: Socket): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> = [];
  private buffered = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: ChromeBridgeEvent) => void>();
  private closed = false;

  constructor(private readonly options: { pipePath: string; requestTimeoutMs?: number }) {
    if (process.platform === "win32" && !/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(options.pipePath)) {
      throw new Error("Chrome extension bridge must use an explicit Windows named pipe");
    }
    this.server = createServer(socket => this.accept(socket));
    this.listening = new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(options.pipePath, () => {
        this.server.off("error", reject);
        this.server.on("error", error => this.fail(error));
        resolve();
      });
    });
  }

  ready(): Promise<void> {
    return this.listening;
  }

  subscribe(listener: (event: ChromeBridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(request: ChromeBridgeRequest): Promise<ChromeBridgeResponse> {
    assertChromeBridgeIdentity(request);
    await this.listening;
    if (this.closed) throw new Error("Chrome extension bridge is closed");
    if (this.pending.has(request.requestId)) {
      throw new Error(`Chrome extension request is already pending: ${request.requestId}`);
    }
    const socket = await this.waitForSocket();
    const timeoutMs = this.options.requestTimeoutMs ?? 15_000;
    const response = new Promise<ChromeBridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error(`Chrome extension request timed out: ${request.type}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(request.requestId, { resolve, reject, timer });
    });
    socket.write(`${JSON.stringify(request)}\n`, error => {
      if (!error) return;
      const pending = this.pending.get(request.requestId);
      if (!pending) return;
      this.pending.delete(request.requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    return response;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("Chrome extension bridge closed"));
    this.socket?.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    if (this.closed || (this.socket && !this.socket.destroyed)) {
      socket.destroy(new Error("A Chrome Native Messaging host is already connected"));
      return;
    }
    this.socket = socket;
    this.buffered = "";
    socket.setEncoding("utf8");
    for (const waiter of this.socketWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(socket);
    }
    this.socketWaiters = [];
    socket.on("data", chunk => this.onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    socket.on("error", error => this.fail(error));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.fail(new Error("Chrome Native Messaging host disconnected"));
    });
  }

  private waitForSocket(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    const timeoutMs = this.options.requestTimeoutMs ?? 15_000;
    return new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socketWaiters = this.socketWaiters.filter(waiter => waiter.resolve !== resolve);
        reject(new Error("Chrome extension is not connected to the Native Messaging host"));
      }, timeoutMs);
      timer.unref?.();
      this.socketWaiters.push({ resolve, reject, timer });
    });
  }

  private onData(chunk: string): void {
    this.buffered += chunk;
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (!line.trim()) continue;
      let message: ChromeBridgeResponse | ChromeBridgeEvent;
      try { message = JSON.parse(line) as ChromeBridgeResponse | ChromeBridgeEvent; }
      catch {
        this.fail(new Error("Chrome Native Messaging host returned invalid JSON"));
        continue;
      }
      try { assertChromeBridgeIdentity(message); }
      catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (eventTypes.has(message.type as ChromeBridgeEvent["type"])) {
        for (const listener of this.listeners) listener(message as ChromeBridgeEvent);
        continue;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) continue;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message as ChromeBridgeResponse);
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.socketWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.socketWaiters = [];
  }
}
