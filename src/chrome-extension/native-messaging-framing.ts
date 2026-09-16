const DEFAULT_MAX_NATIVE_MESSAGE_BYTES = 16 * 1024 * 1024;

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > DEFAULT_MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error("Native Messaging frame exceeds the 16 MB bridge limit");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  private buffered = Buffer.alloc(0);

  constructor(private readonly maxBytes = DEFAULT_MAX_NATIVE_MESSAGE_BYTES) {}

  push(chunk: Uint8Array): unknown[] {
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const decoded: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length > this.maxBytes) {
        this.buffered = Buffer.alloc(0);
        throw new Error(`Native Messaging frame exceeds the ${this.maxBytes} byte limit`);
      }
      if (this.buffered.length < 4 + length) break;
      const body = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      try { decoded.push(JSON.parse(body.toString("utf8"))); }
      catch { throw new Error("Native Messaging frame is not valid JSON"); }
    }
    return decoded;
  }
}

