import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { NativeMessageDecoder, encodeNativeMessage } from "./native-messaging-framing";

interface NativeHostConfig {
  version: 1;
  pipePath: string;
}

function configPath(): string {
  const explicit = process.env.CODEX_CHATGPT_WEB_NATIVE_HOST_CONFIG?.trim();
  if (explicit) return resolve(explicit);
  const home = process.env.CODEX_CHATGPT_WEB_HOME?.trim()
    ? resolve(process.env.CODEX_CHATGPT_WEB_HOME)
    : join(homedir(), ".codex-chatgpt-web");
  return join(home, "chrome-extension", "native-host.json");
}

function loadConfig(): NativeHostConfig {
  const decoded = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<NativeHostConfig>;
  if (decoded.version !== 1 || typeof decoded.pipePath !== "string" || !decoded.pipePath.trim()) {
    throw new Error("Native host configuration is invalid");
  }
  if (process.platform === "win32" && !/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(decoded.pipePath)) {
    throw new Error("Native host configuration must use a Windows named pipe");
  }
  return { version: 1, pipePath: decoded.pipePath };
}

function safeFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[codex-chatgpt-web-native-host] ${message}\n`);
  process.exitCode = 1;
}

try {
  const config = loadConfig();
  const socket = createConnection(config.pipePath);
  const nativeDecoder = new NativeMessageDecoder();
  let pipeBuffer = "";
  let settled = false;

  const stop = (error?: unknown): void => {
    if (settled) return;
    settled = true;
    if (error) safeFailure(error);
    socket.destroy();
    process.stdin.pause();
  };

  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    pipeBuffer += chunk;
    while (true) {
      const newline = pipeBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = pipeBuffer.slice(0, newline);
      pipeBuffer = pipeBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); }
      catch {
        stop(new Error("Local bridge sent invalid JSON"));
        return;
      }
      process.stdout.write(encodeNativeMessage(value));
    }
  });
  socket.on("error", stop);
  socket.on("close", () => stop());

  process.stdin.on("data", chunk => {
    try {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      for (const message of nativeDecoder.push(bytes)) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
    } catch (error) {
      stop(error);
    }
  });
  process.stdin.on("error", stop);
  process.stdin.on("end", () => stop());
} catch (error) {
  safeFailure(error);
}
