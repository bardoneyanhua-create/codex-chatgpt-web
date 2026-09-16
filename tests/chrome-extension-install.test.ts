import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
  installChromeNativeHost,
  nativeHostManifest,
} from "../src/chrome-extension/install";

describe("Chrome Native Messaging installation", () => {
  test("manifest authorizes only the stable extension id", () => {
    const manifest = JSON.parse(nativeHostManifest("C:\\app\\host.exe"));
    expect(manifest.name).toBe(CHROME_NATIVE_HOST_NAME);
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${CHROME_EXTENSION_ID}/`]);
    expect(manifest.type).toBe("stdio");
  });

  test("fails before registry mutation when inputs are incomplete", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-ext-install-"));
    const calls: unknown[] = [];
    try {
      mkdirSync(join(root, "extension"));
      writeFileSync(join(root, "host.exe"), "fixture");
      expect(() => installChromeNativeHost({
        hostExecutable: join(root, "host.exe"),
        extensionDirectory: join(root, "extension"),
        runner: (command, args) => { calls.push([command, args]); return { status: 0, stdout: "", stderr: "" }; },
      })).toThrow("manifest is missing");
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
