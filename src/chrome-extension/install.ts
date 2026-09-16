import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir, isWindowsPipeEndpoint } from "../config";
import { runCommand, type CommandResult } from "../process";

export const CHROME_NATIVE_HOST_NAME = "com.bardoneyanhua.codex_chatgpt_web";
export const CHROME_EXTENSION_ID = "goagchmhjafgjjeoiomdnieebpnabkjl";

interface ChromeExtensionInstallJournal {
  version: 1;
  registryKey: string;
  previousRegistryValue: string | null;
  nativeHostManifestPath: string;
  nativeHostConfigPath: string;
  extensionDirectory: string;
  hostExecutable: string;
  pipePath: string;
}

type Runner = (command: string, args: string[]) => CommandResult;

export function defaultChromeExtensionPipePath(home = getConfigDir()): string {
  const safe = Bun.hash(resolve(home).toLowerCase()).toString(16).replace("-", "n");
  return `\\\\.\\pipe\\codex-chatgpt-web-extension-${safe}`;
}

export function chromeNativeHostRegistryKey(): string {
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${CHROME_NATIVE_HOST_NAME}`;
}

export function nativeHostManifest(hostExecutable: string, extensionId = CHROME_EXTENSION_ID): string {
  return `${JSON.stringify({
    name: CHROME_NATIVE_HOST_NAME,
    description: "Codex ChatGPT Web Backend local bridge",
    path: resolve(hostExecutable),
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2)}\n`;
}

function installDirectory(): string {
  return join(getConfigDir(), "chrome-extension");
}

function journalPath(): string {
  return join(installDirectory(), "install-journal.json");
}

function queryRegistryValue(key: string, runner: Runner): string | null {
  const result = runner("reg.exe", ["query", key, "/ve"]);
  if (result.status !== 0) return null;
  const match = result.stdout.match(/REG_SZ\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

export function installChromeNativeHost(options: {
  hostExecutable: string;
  extensionDirectory: string;
  pipePath?: string;
  runner?: Runner;
}): ChromeExtensionInstallJournal {
  if (process.platform !== "win32") throw new Error("Chrome Extension Backend installer currently supports Windows only");
  const hostExecutable = resolve(options.hostExecutable);
  const extensionDirectory = resolve(options.extensionDirectory);
  if (!existsSync(hostExecutable)) throw new Error(`Native Messaging host executable is missing: ${hostExecutable}`);
  if (!existsSync(join(extensionDirectory, "manifest.json"))) {
    throw new Error(`Chrome extension manifest is missing: ${extensionDirectory}`);
  }
  const pipePath = options.pipePath ?? defaultChromeExtensionPipePath();
  if (!isWindowsPipeEndpoint(pipePath)) throw new Error("Chrome extension bridge must use a Windows named pipe");
  const runner = options.runner ?? runCommand;
  const existing = inspectChromeNativeHost(runner);
  if (existing.journal) {
    if (existing.installed
      && existing.journal.hostExecutable === hostExecutable
      && existing.journal.extensionDirectory === extensionDirectory
      && existing.journal.pipePath === pipePath) return existing.journal;
    throw new Error("Chrome Native Messaging installation already exists with different or drifted settings");
  }
  const registryKey = chromeNativeHostRegistryKey();
  const nativeHostManifestPath = join(installDirectory(), `${CHROME_NATIVE_HOST_NAME}.json`);
  const nativeHostConfigPath = join(installDirectory(), "native-host.json");
  const previousRegistryValue = queryRegistryValue(registryKey, runner);
  const journal: ChromeExtensionInstallJournal = {
    version: 1,
    registryKey,
    previousRegistryValue,
    nativeHostManifestPath,
    nativeHostConfigPath,
    extensionDirectory,
    hostExecutable,
    pipePath,
  };
  atomicWriteFile(nativeHostManifestPath, nativeHostManifest(hostExecutable));
  atomicWriteFile(nativeHostConfigPath, `${JSON.stringify({ version: 1, pipePath }, null, 2)}\n`);
  atomicWriteFile(journalPath(), `${JSON.stringify(journal, null, 2)}\n`);
  const result = runner("reg.exe", ["add", registryKey, "/ve", "/t", "REG_SZ", "/d", nativeHostManifestPath, "/f"]);
  if (result.status !== 0) {
    rmSync(journalPath(), { force: true });
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not register the Chrome Native Messaging host");
  }
  return journal;
}

export function inspectChromeNativeHost(runner: Runner = runCommand): {
  installed: boolean;
  registryValue: string | null;
  journal?: ChromeExtensionInstallJournal;
} {
  const registryValue = process.platform === "win32"
    ? queryRegistryValue(chromeNativeHostRegistryKey(), runner)
    : null;
  if (!existsSync(journalPath())) return { installed: false, registryValue };
  const journal = JSON.parse(readFileSync(journalPath(), "utf8")) as ChromeExtensionInstallJournal;
  return {
    installed: registryValue === journal.nativeHostManifestPath
      && existsSync(journal.nativeHostManifestPath)
      && existsSync(journal.nativeHostConfigPath),
    registryValue,
    journal,
  };
}

export function uninstallChromeNativeHost(runner: Runner = runCommand): void {
  if (process.platform !== "win32") throw new Error("Chrome Extension Backend installer currently supports Windows only");
  if (!existsSync(journalPath())) return;
  const journal = JSON.parse(readFileSync(journalPath(), "utf8")) as ChromeExtensionInstallJournal;
  const current = queryRegistryValue(journal.registryKey, runner);
  if (current !== journal.nativeHostManifestPath) {
    throw new Error("Chrome Native Messaging registry value changed after installation; refusing to overwrite it");
  }
  if (journal.previousRegistryValue) {
    const result = runner("reg.exe", ["add", journal.registryKey, "/ve", "/t", "REG_SZ", "/d", journal.previousRegistryValue, "/f"]);
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not restore the previous Chrome Native Messaging host");
    }
  } else {
    const result = runner("reg.exe", ["delete", journal.registryKey, "/f"]);
    if (result.status !== 0 && !/unable to find|找不到/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not remove the Chrome Native Messaging host");
    }
  }
  rmSync(journal.nativeHostManifestPath, { force: true });
  rmSync(journal.nativeHostConfigPath, { force: true });
  rmSync(journalPath(), { force: true });
  try { rmSync(dirname(journalPath()), { recursive: false }); } catch {}
}
