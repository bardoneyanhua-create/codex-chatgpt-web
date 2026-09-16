import type { BrowserTurn } from "../adapters/chatgpt-web/browser-worker";

export interface BrowserSessionInspection {
  authenticated: true;
  temporary: true;
  url: string;
  solAvailable?: boolean;
  extraHighAvailable?: boolean;
  proAvailable?: boolean;
}

/**
 * Browser ownership boundary used by the Responses adapter.
 *
 * `run` owns the complete task-page lifecycle: obtain one task-bound page, open or retain its
 * conversation, submit text, prove answer start, emit append-only deltas, prove completion, react
 * to reload/destruction, and close or retain that exact page. AbortSignal is the cancellation
 * boundary. `inspectSession`, `smokeTest`, and `close` provide login/health/error and backend
 * lifecycle operations without exposing Electron, CDP, or Chrome tab internals to the adapter.
 */
export interface BrowserBackend {
  readonly kind: "electron" | "chrome-extension";
  run(turn: BrowserTurn): Promise<string>;
  inspectSession(detectCapabilities: boolean): Promise<BrowserSessionInspection>;
  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }>;
  close(): Promise<void>;
}

