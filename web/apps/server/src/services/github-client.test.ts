import { describe, expect, it, vi } from "vitest";
import { createGithubClient } from "./github-client.js";

describe("createGithubClient", () => {
  it("cancels metadata responses whose declared size exceeds the limit", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: 200,
        headers: {
          "Content-Length": String(16 * 1024 * 1024 + 1),
          "Content-Type": "application/json",
        },
      }),
    );
    const client = createGithubClient(null, { fetchImpl });

    await expect(client.rest.repos.get({ owner: "print", repo: "partner" }))
      .rejects.toThrow("Response body exceeds 16777216 bytes");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts when GitHub never returns response headers", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) => {
        requestSignal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      },
    );
    const client = createGithubClient(null, { fetchImpl, timeoutMs: 25 });

    await expect(
      client.rest.repos.get({ owner: "print", repo: "partner" }),
    ).rejects.toThrow();
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("aborts when GitHub returns headers but stalls the response body", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) => {
        requestSignal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              requestSignal?.addEventListener(
                "abort",
                () => controller.error(requestSignal?.reason),
                { once: true },
              );
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const client = createGithubClient(null, { fetchImpl, timeoutMs: 25 });

    await expect(
      client.rest.repos.get({ owner: "print", repo: "partner" }),
    ).rejects.toThrow();
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
  });
});
