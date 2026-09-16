import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "chrome-extension");

test("Chrome extension manifest has only the required site and Native Messaging access", () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(["nativeMessaging"]);
  expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*"]);
  expect(JSON.stringify(manifest)).not.toContain("cookies");
  expect(JSON.stringify(manifest)).not.toContain("history");
  expect(JSON.stringify(manifest)).not.toContain("debugger");
  expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
});

test("extension sources never select the active tab or read cookies", () => {
  const source = ["service-worker.js", "content-script.js"]
    .map(file => readFileSync(join(root, file), "utf8"))
    .join("\n");
  expect(source).not.toContain("active: true");
  expect(source).not.toContain("chrome.cookies");
  expect(source).not.toContain("chrome.debugger");
  expect(source).not.toContain("chrome.history");
  expect(source).not.toContain("currentWindow");
});

