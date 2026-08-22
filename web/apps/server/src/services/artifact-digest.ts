import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

const HASH_BUFFER_BYTES = 64 * 1024;

export function sha256File(path: string): string {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  const hash = createHash("sha256");
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}
