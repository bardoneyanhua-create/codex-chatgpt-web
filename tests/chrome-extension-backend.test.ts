import { describe, expect, test } from "bun:test";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import {
  ChromeExtensionBackend,
  type ChromeExtensionTransport,
} from "../src/browser-backends/chrome-extension-backend";
import type {
  ChromeBridgeEvent,
  ChromeBridgeRequest,
  ChromeBridgeResponse,
} from "../src/chrome-extension/protocol";

class FakeTransport implements ChromeExtensionTransport {
  readonly requests: ChromeBridgeRequest[] = [];
  private readonly listeners = new Set<(event: ChromeBridgeEvent) => void>();
  private nextTab = 10;
  private readonly tabs = new Map<string, number>();

  async request(request: ChromeBridgeRequest): Promise<ChromeBridgeResponse> {
    this.requests.push(request);
    if (request.type === "create_task") {
      const tabId = this.tabs.get(request.taskId) ?? this.nextTab++;
      this.tabs.set(request.taskId, tabId);
      return { ...request, type: "task_created", ok: true, tabId };
    }
    return { ...request, type: "ack", ok: true };
  }

  subscribe(listener: (event: ChromeBridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ChromeBridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async close(): Promise<void> {}
}

function turn(traceId: string, taskId: string, deltas: string[]): BrowserTurn {
  return {
    traceId,
    modelId: "chatgpt-web-chrome-default",
    capabilities: {
      localToolsEnabled: false,
      solAvailable: false,
      extraHighAvailable: false,
      proAvailable: false,
    },
    conversationKey: taskId,
    retainConversation: true,
    prepare: async () => ({ text: `prompt:${taskId}`, images: [], release: () => {} }),
    onTextDelta: delta => deltas.push(delta),
  };
}

function event(
  type: ChromeBridgeEvent["type"],
  request: ChromeBridgeRequest,
  text?: string,
): ChromeBridgeEvent {
  return {
    version: 1,
    type,
    instanceId: request.instanceId,
    taskId: request.taskId,
    requestId: request.requestId,
    tabId: request.tabId!,
    ...(text === undefined ? {} : { text }),
  } as ChromeBridgeEvent;
}

describe("ChromeExtensionBackend", () => {
  test("keeps simultaneous task replies isolated by instance, task, tab and request", async () => {
    const transport = new FakeTransport();
    const backend = new ChromeExtensionBackend({ instanceId: "instance-a", transport });
    const a: string[] = [];
    const b: string[] = [];
    const runA = backend.run(turn("trace-a", "task-a", a));
    const runB = backend.run(turn("trace-b", "task-b", b));
    await Bun.sleep(0);

    const sends = transport.requests.filter(request => request.type === "send_text");
    expect(sends).toHaveLength(2);
    const sendA = sends.find(request => request.taskId === "task-a")!;
    const sendB = sends.find(request => request.taskId === "task-b")!;
    expect(sendA.tabId).not.toBe(sendB.tabId);

    transport.emit(event("answer_started", sendB));
    transport.emit(event("answer_delta", sendB, "bravo"));
    transport.emit(event("answer_complete", sendB, "bravo"));
    transport.emit(event("answer_started", sendA));
    transport.emit(event("answer_delta", sendA, "alpha"));
    transport.emit(event("answer_complete", sendA, "alpha"));

    expect(await runA).toBe("alpha");
    expect(await runB).toBe("bravo");
    expect(a).toEqual(["alpha"]);
    expect(b).toEqual(["bravo"]);
  });

  test("reuses the dedicated tab for a follow-up in the same task", async () => {
    const transport = new FakeTransport();
    const backend = new ChromeExtensionBackend({ instanceId: "instance-a", transport });
    const first = backend.run(turn("trace-1", "same-task", []));
    await Bun.sleep(0);
    const firstSend = transport.requests.find(request => request.type === "send_text")!;
    transport.emit(event("answer_started", firstSend));
    transport.emit(event("answer_complete", firstSend, "one"));
    expect(await first).toBe("one");

    const second = backend.run(turn("trace-2", "same-task", []));
    await Bun.sleep(0);
    const sends = transport.requests.filter(request => request.type === "send_text");
    const secondSend = sends.at(-1)!;
    expect(secondSend.tabId).toBe(firstSend.tabId);
    expect(transport.requests.filter(request => request.type === "create_task")).toHaveLength(1);
    transport.emit(event("answer_started", secondSend));
    transport.emit(event("answer_complete", secondSend, "two"));
    expect(await second).toBe("two");
  });

  test("fails only the bound task when its tab is closed", async () => {
    const transport = new FakeTransport();
    const backend = new ChromeExtensionBackend({ instanceId: "instance-a", transport });
    const runA = backend.run(turn("trace-a", "task-a", []));
    const runB = backend.run(turn("trace-b", "task-b", []));
    await Bun.sleep(0);
    const sends = transport.requests.filter(request => request.type === "send_text");
    const sendA = sends.find(request => request.taskId === "task-a")!;
    const sendB = sends.find(request => request.taskId === "task-b")!;
    transport.emit(event("page_closed", sendA));
    transport.emit(event("answer_started", sendB));
    transport.emit(event("answer_complete", sendB, "still-b"));
    await expect(runA).rejects.toThrow("closed");
    expect(await runB).toBe("still-b");
  });

  test("fails closed when a streamed snapshot rewrites emitted text", async () => {
    const transport = new FakeTransport();
    const backend = new ChromeExtensionBackend({ instanceId: "instance-a", transport });
    const run = backend.run(turn("trace-a", "task-a", []));
    await Bun.sleep(0);
    const send = transport.requests.find(request => request.type === "send_text")!;
    transport.emit(event("answer_started", send));
    transport.emit(event("answer_delta", send, "stable"));
    transport.emit(event("answer_delta", send, "changed"));
    await expect(run).rejects.toThrow("rewrote");
  });

  test("fails the exact active task on reload or logout without borrowing another tab", async () => {
    for (const failure of ["page_reloaded", "logged_out"] as const) {
      const transport = new FakeTransport();
      const backend = new ChromeExtensionBackend({ instanceId: "instance-a", transport });
      const run = backend.run(turn(`trace-${failure}`, `task-${failure}`, []));
      await Bun.sleep(0);
      const send = transport.requests.find(request => request.type === "send_text")!;
      transport.emit(event(failure, send));
      await expect(run).rejects.toThrow(failure.replaceAll("_", " "));
      expect(transport.requests.filter(request => request.type === "create_task")).toHaveLength(1);
    }
  });
});
