import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const CHUNK_BYTES = 64 * 1024;

export type ByteChunk = readonly [chunk: Uint8Array, final: boolean];

export function* bufferChunks(bytes: Uint8Array): Generator<ByteChunk> {
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const end = Math.min(bytes.length, offset + CHUNK_BYTES);
    yield [bytes.subarray(offset, end), end === bytes.length];
  }
}

/** Each chunk is a fresh buffer, so consumers may keep a reference to it. */
export function* fileChunks(path: string): Generator<ByteChunk> {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    let position = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      const read = readSync(descriptor, chunk, 0, chunk.length, position);
      position += read;
      const final = read === 0 || position >= size;
      yield [chunk.subarray(0, read), final];
      if (final) return;
    }
  } finally {
    closeSync(descriptor);
  }
}
