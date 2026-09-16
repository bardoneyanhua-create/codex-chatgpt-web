export const CHROME_EXTENSION_PROTOCOL_VERSION = 1 as const;

export interface ChromeBridgeIdentity {
  version: typeof CHROME_EXTENSION_PROTOCOL_VERSION;
  instanceId: string;
  taskId: string;
  requestId: string;
  tabId?: number;
}

export type ChromeBridgeRequest = ChromeBridgeIdentity & (
  | { type: "inspect_session" }
  | { type: "create_task" }
  | { type: "open_conversation" }
  | { type: "send_text"; text: string }
  | { type: "cancel_answer" }
  | { type: "close_task" }
  | { type: "task_health" }
  | { type: "smoke"; text: string }
);

export type ChromeBridgeResponse = ChromeBridgeIdentity & {
  type: "ack" | "task_created" | "session" | "health" | "smoke_result" | "error";
  ok: boolean;
  error?: string;
  authenticated?: boolean;
  temporary?: boolean;
  url?: string;
  healthy?: boolean;
  text?: string;
};

export type ChromeBridgeEvent = Required<ChromeBridgeIdentity> & {
  type:
    | "answer_started"
    | "answer_delta"
    | "answer_complete"
    | "page_closed"
    | "page_reloaded"
    | "logged_out"
    | "structure_error"
    | "page_error";
  text?: string;
  error?: string;
};

export function assertChromeBridgeIdentity(value: ChromeBridgeIdentity): void {
  if (value.version !== CHROME_EXTENSION_PROTOCOL_VERSION) {
    throw new Error("Chrome extension protocol version is unsupported");
  }
  for (const [name, part] of Object.entries({
    instanceId: value.instanceId,
    taskId: value.taskId,
    requestId: value.requestId,
  })) {
    if (typeof part !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(part)) {
      throw new Error(`Chrome extension ${name} is invalid`);
    }
  }
  if (value.tabId !== undefined && (!Number.isSafeInteger(value.tabId) || value.tabId < 0)) {
    throw new Error("Chrome extension tabId is invalid");
  }
}

