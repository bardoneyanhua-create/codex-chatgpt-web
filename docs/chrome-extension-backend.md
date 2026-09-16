# Chrome Extension Backend (MVP)

This branch keeps the existing Codex Responses bridge and replaces only its browser ownership boundary when `browserHost` is `chrome-extension`.

## Architecture

`src/bridge.ts`, `src/server.ts`, `src/model-catalog.ts`, and the Codex integration journal remain the Codex-facing model bridge. The ChatGPT adapter continues to own prompt compilation, Responses events, task context, cancellation, and lifecycle semantics.

`BrowserBackend` is the browser boundary. `ElectronBrowserBackend` delegates to the released `ChatGptBrowserWorker`; `ChromeExtensionBackend` delegates to a Chrome MV3 extension through Native Messaging and a current-user named pipe. The upper adapter selects one backend explicitly and never falls back to a native Codex model.

The extension creates an inactive `https://chatgpt.com/?temporary-chat=true` tab for each `(instanceId, taskId)` pair. Every request and event also carries `requestId` and `tabId`. It never binds the active tab or an existing user conversation. The MV3 service worker stores only these task-to-tab bindings in `chrome.storage.session`, so a worker restart cannot silently attach a task to a different tab. Ambiguous DOM, reloads, closed tabs, logged-out pages, and rejected prompt submissions fail closed. Because the ChatGPT page can rewrite draft text while generating, the MVP withholds draft deltas and returns the verified final answer once generation completes.

The MVP publishes one honest route, `ChatGPT Web — Chrome Default`. It does not claim to select Instant, Medium, High, or Pro because the extension deliberately leaves the webpage model at the account's current/default choice. Images and Full Harness tool callbacks are out of scope.

## Security boundary

The extension requests only `nativeMessaging`, session-scoped `storage`, and `https://chatgpt.com/*`. It has no cookie, history, debugger, password, or all-sites permission. The session store contains only task, tab, and request routing identifiers; it never contains prompts, answers, cookies, or tokens. Authentication remains entirely inside the normal Chrome profile. Neither the extension nor the local host reads, exports, copies, or stores cookies or login tokens. Chrome remote debugging is not used.

The local Responses listener remains bound to `127.0.0.1`. Native Messaging is registered under the current Windows user only. The install journal records the previous registry value, and the existing Codex integration journal owns reversible changes to Codex configuration.

## Build and connect

Use the repository-pinned Bun version:

```powershell
bun install --frozen-lockfile
bun run build
dist\runtime\bin\codex-chatgpt-web.cmd chrome-extension connect `
  --host-executable dist\runtime\chrome-extension\codex-chatgpt-web-native-host.exe `
  --extension-dir dist\runtime\chrome-extension
```

Load the unpacked extension in the intended Chrome profile:

1. Enter `chrome://extensions` in Chrome's address bar and press Enter.
2. Turn on the `Developer mode` switch in the upper-right corner. When Chrome says the switch is on, this is the correct setting; it does not mean Chrome itself is running with remote debugging.
3. Select the `Load unpacked` button.
4. In the folder picker, select `dist/runtime/chrome-extension`, then select `Select Folder`.
5. Confirm that the `Codex ChatGPT Web Bridge` card is enabled. After rebuilding later, select the card's `Reload` button once.

Then run the local bridge with `dist/runtime/bin/codex-chatgpt-web.cmd serve`. Keep that terminal open while Codex is using the route. Verify the native link with `chrome-extension check` only after the extension is loaded. Chrome and ChatGPT must remain signed in using the same ordinary Chrome profile; no cookie export or remote-debugging launch is required.

## Rollback

Run `chrome-extension disconnect`. It restores the previous Codex route through the upstream integration journal, restores or removes the exact current-user Native Messaging registry value, and removes only the host files owned by this installation. Removing the unpacked extension from Chrome is the final profile-local cleanup step.
