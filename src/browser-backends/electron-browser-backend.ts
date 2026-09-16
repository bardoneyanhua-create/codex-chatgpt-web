import {
  ChatGptBrowserWorker,
  type BrowserTurn,
} from "../adapters/chatgpt-web/browser-worker";
import type { CodexProviderConfig } from "../types";
import type { BrowserBackend } from "./types";

/** Preserves the released Electron/managed-Chrome worker without changing its behavior. */
export class ElectronBrowserBackend implements BrowserBackend {
  readonly kind = "electron" as const;

  static forProvider(provider: CodexProviderConfig): ElectronBrowserBackend {
    return new ElectronBrowserBackend(ChatGptBrowserWorker.forProvider(provider));
  }

  constructor(private readonly worker: ChatGptBrowserWorker) {}

  run(turn: BrowserTurn): Promise<string> {
    return this.worker.run(turn);
  }

  inspectSession(detectCapabilities: boolean) {
    return this.worker.inspectSession(detectCapabilities);
  }

  smokeTest(abortSignal?: AbortSignal) {
    return this.worker.smokeTest(abortSignal);
  }

  close(): Promise<void> {
    return this.worker.close();
  }
}

