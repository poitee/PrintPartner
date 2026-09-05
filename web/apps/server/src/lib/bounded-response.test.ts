import { describe, expect, it, vi } from "vitest";
import {
  cancelResponseBody,
  isJsonObject,
  readBoundedJsonResponse,
  readBoundedResponseBody,
  readBoundedResponseChunks,
  readResponsePrefix,
  ResponseBodyTooLargeError,
} from "./bounded-response.js";

describe("readBoundedResponseBody", () => {
  it("returns a response whose streamed body fits the limit", async () => {
    const response = new Response("hello", {
      headers: { "content-length": "5" },
    });

    await expect(readBoundedResponseBody(response, 5)).resolves.toEqual(
      new TextEncoder().encode("hello"),
    );
  });

  it("rejects an oversized declared body before reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        cancel,
      }),
      { headers: { "content-length": "6" } },
    );

    await expect(readBoundedResponseBody(response, 5)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a streamed body as soon as it crosses the limit", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
        },
        cancel,
      }),
    );

    await expect(readBoundedResponseBody(response, 5)).rejects.toThrow(
      "Response body exceeds 5 bytes",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels discarded response bodies without surfacing cancellation errors", async () => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw new Error("socket already closed");
        },
      }),
    );

    await expect(cancelResponseBody(response)).resolves.toBeUndefined();
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects the invalid byte limit %s",
    async (maxBytes) => {
      await expect(readBoundedResponseBody(new Response("body"), maxBytes))
        .rejects.toThrow("maxBytes must be a non-negative safe integer");
    },
  );

  it("cancels the upstream when a chunk consumer stops early", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2]));
      },
      cancel,
    }));

    for await (const _chunk of readBoundedResponseChunks(response, 2)) {
      break;
    }

    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("readResponsePrefix", () => {
  it("reads and cancels after the prefix when the declared body is larger", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("metadata then the rest"));
        },
        cancel,
      }),
      { headers: { "content-length": "1048576" } },
    );

    await expect(readResponsePrefix(response, 8)).resolves.toEqual(
      new TextEncoder().encode("metadata"),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("isJsonObject", () => {
  it("accepts JSON objects but not arrays or null", () => {
    expect(isJsonObject({ value: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});

describe("readBoundedJsonResponse", () => {
  it("cancels and rejects chunked JSON that crosses the byte limit", async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"message":"'));
          controller.enqueue(encoder.encode("too large"));
          controller.enqueue(encoder.encode('"}'));
          controller.close();
        },
        cancel,
      }),
    );

    await expect(readBoundedJsonResponse(response, 16)).rejects.toThrow(
      "Response body exceeds 16 bytes",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
