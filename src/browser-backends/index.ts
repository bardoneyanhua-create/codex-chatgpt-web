import type { CodexProviderConfig } from "../types";
import { ChromeExtensionBackend } from "./chrome-extension-backend";
import { ElectronBrowserBackend } from "./electron-browser-backend";
import type { BrowserBackend } from "./types";
import { closeChatGptBrowserWorkers } from "../adapters/chatgpt-web/browser-worker";

export type { BrowserBackend } from "./types";

const chromeBackends = new Map<string, BrowserBackend>();

export function createBrowserBackend(
  provider: CodexProviderConfig,
  factories: {
    electron?: (provider: CodexProviderConfig) => BrowserBackend;
    chromeExtension?: (provider: CodexProviderConfig) => BrowserBackend;
  } = {},
): BrowserBackend {
  if (provider.chatgptWeb?.browserHost === "chrome-extension") {
    if (factories.chromeExtension) return factories.chromeExtension(provider);
    const key = JSON.stringify({
      baseUrl: provider.baseUrl,
      extensionId: provider.chatgptWeb.chromeExtensionId,
      pipePath: provider.chatgptWeb.chromeExtensionPipePath,
      instanceId: provider.chatgptWeb.chromeExtensionInstanceId,
    });
    let backend = chromeBackends.get(key);
    if (!backend) {
      backend = ChromeExtensionBackend.forProvider(provider);
      chromeBackends.set(key, backend);
    }
    return backend;
  }
  return (factories.electron ?? ElectronBrowserBackend.forProvider)(provider);
}

export async function closeBrowserBackends(): Promise<void> {
  const chrome = [...chromeBackends.values()];
  chromeBackends.clear();
  const results = await Promise.allSettled([
    ...chrome.map(backend => backend.close()),
    closeChatGptBrowserWorkers(),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, "Browser backends failed to close");
}

export { ChromeExtensionBackend, ElectronBrowserBackend };
