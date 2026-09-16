import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import {
  ChromeNativeMessagingTransport,
} from "../src/chrome-extension/bridge-transport";
import {
  NativeMessageDecoder,
  encodeNativeMessage,
} from "../src/chrome-extension/native-messaging-framing";
import type { ChromeBridgeEvent, ChromeBridgeRequest } from "../src/chrome-extension/protocol";

test("Native Messaging framing decodes fragmented and coalesced Chrome frames", () => {
  const decoder = new NativeMessageDecoder();
  const first = encodeNativeMessage({ type: "first", value: 1 });
  const second = encodeNativeMessage({ type: "second", value: 2 });
  expect(decoder.push(first.subarray(0, 3))).toEqual([]);
  expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
    { type: "first", value: 1 },
    { type: "second", value: 2 },
  ]);
});

test("Native Messaging framing rejects an oversized frame before allocation", () => {
  const decoder = new NativeMessageDecoder(32);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(33);
  expect(() => decoder.push(header)).toThrow("exceeds");
});

test("Chrome extension transport correlates requests and forwards task events over a real named pipe", async () => {
  const pipePath = `\\\\.\\pipe\\codex-chatgpt-web-test-${crypto.randomUUID()}`;
  const transport = new ChromeNativeMessagingTransport({ pipePath, requestTimeoutMs: 2_000 });
  await transport.ready();
  const client = createConnection(pipePath);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.setEncoding("utf8");
  let buffered = "";
  client.on("data", chunk => {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffered.slice(0, newline)) as ChromeBridgeRequest;
    buffered = buffered.slice(newline + 1);
    client.write(`${JSON.stringify({ ...request, type: "ack", ok: true })}\n`);
    const event: ChromeBridgeEvent = {
      version: 1,
      type: "answer_started",
      instanceId: request.instanceId,
      taskId: request.taskId,
      requestId: request.requestId,
      tabId: request.tabId!,
    };
    client.write(`${JSON.stringify(event)}\n`);
  });

  const events: ChromeBridgeEvent[] = [];
  transport.subscribe(event => events.push(event));
  const request: ChromeBridgeRequest = {
    version: 1,
    type: "send_text",
    instanceId: "instance-a",
    taskId: "task-a",
    requestId: "request-a",
    tabId: 17,
    text: "hello",
  };
  expect(await transport.request(request)).toMatchObject({ ok: true, requestId: "request-a" });
  await Bun.sleep(10);
  expect(events).toEqual([expect.objectContaining({ type: "answer_started", tabId: 17 })]);
  client.destroy();
  await transport.close();
});

