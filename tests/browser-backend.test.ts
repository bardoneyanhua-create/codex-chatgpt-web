import { describe, expect, test } from "bun:test";
import type { CodexProviderConfig } from "../src/types";
import {
  createBrowserBackend,
  type BrowserBackend,
} from "../src/browser-backends/index";

function provider(browserHost: "launcher" | "managed-chrome" | "chrome-extension"): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    chatgptWeb: {
      browserHost,
      ...(browserHost === "launcher"
        ? { browserHostDescriptorPath: "C:\\runtime\\launcher.json" }
        : {}),
      ...(browserHost === "chrome-extension"
        ? {
            chromeExtensionId: "abcdefghijklmnopabcdefghijklmnop",
            chromeExtensionPipePath: "\\\\.\\pipe\\codex-chatgpt-web-extension-test",
          }
        : {}),
    },
  };
}

describe("BrowserBackend selection", () => {
  test("preserves the existing browser worker behind ElectronBrowserBackend", () => {
    const delegated: BrowserBackend = {
      kind: "electron",
      run: async () => "ok",
      inspectSession: async () => ({ authenticated: true, temporary: true, url: "https://chatgpt.com/?temporary-chat=true" }),
      smokeTest: async () => ({ effort: "low", response: "ok" }),
      close: async () => {},
    };
    const backend = createBrowserBackend(provider("launcher"), {
      electron: () => delegated,
    });
    expect(backend).toBe(delegated);
    expect(backend.kind).toBe("electron");
  });

  test("selects the Chrome extension backend only for the explicit host", () => {
    const chrome: BrowserBackend = {
      kind: "chrome-extension",
      run: async () => "ok",
      inspectSession: async () => ({ authenticated: true, temporary: true, url: "https://chatgpt.com/?temporary-chat=true" }),
      smokeTest: async () => ({ effort: "account-default", response: "ok" }),
      close: async () => {},
    };
    const backend = createBrowserBackend(provider("chrome-extension"), {
      chromeExtension: () => chrome,
    });
    expect(backend).toBe(chrome);
    expect(backend.kind).toBe("chrome-extension");
  });
});

