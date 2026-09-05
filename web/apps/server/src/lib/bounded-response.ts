export class ResponseBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response body exceeds ${maxBytes} bytes`);
    this.name = "ResponseBodyTooLargeError";
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validateByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The caller is deliberately discarding this response.
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of readBoundedResponseChunks(response, maxBytes)) {
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readResponsePrefix(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  validateByteLimit(maxBytes);
  if (maxBytes === 0) {
    await cancelResponseBody(response);
    return new Uint8Array();
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let complete = false;
  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      const remainingBytes = maxBytes - totalBytes;
      const chunk = value.byteLength > remainingBytes
        ? value.subarray(0, remainingBytes)
        : value;
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        // The requested prefix is already available.
      }
    }
  }

  const prefix = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return prefix;
}

export async function* readBoundedResponseChunks(
  response: Response,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  validateByteLimit(maxBytes);

  const declaredBytes = declaredContentLength(response);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    await cancelResponseBody(response);
    throw new ResponseBodyTooLargeError(maxBytes);
  }
  if (!response.body) return;

  const reader = response.body.getReader();
  let totalBytes = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      yield value;
    }
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the caller's error when the upstream cannot be cancelled.
      }
    }
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const body = await readBoundedResponseBody(response, maxBytes);
  return new TextDecoder().decode(body);
}

export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const parsed: unknown = JSON.parse(
    await readBoundedResponseText(response, maxBytes),
  );
  return parsed;
}
