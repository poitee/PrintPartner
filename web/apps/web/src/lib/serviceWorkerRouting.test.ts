import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type FetchEvent = {
  request: Request;
  respondWith(response: Promise<Response>): void;
};

function loadFetchListener(): (event: FetchEvent) => void {
  let fetchListener: ((event: FetchEvent) => void) | undefined;
  const cache = {
    match: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    addAll: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    URL,
    Request,
    Response,
    fetch: vi.fn().mockResolvedValue(new Response("ok")),
    caches: {
      open: vi.fn().mockResolvedValue(cache),
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    },
    self: {
      location: { origin: "http://127.0.0.1:5173" },
      registration: {},
      clients: { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue([]) },
      skipWaiting: vi.fn(),
      addEventListener(type: string, listener: (event: FetchEvent) => void) {
        if (type === "fetch") fetchListener = listener;
      },
    },
  };

  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, context);
  if (!fetchListener) throw new Error("Service worker did not register a fetch listener");
  return fetchListener;
}

describe("service worker fetch routing", () => {
  it.each(["POST", "PUT", "DELETE"])(
    "does not pass ordinary %s requests to a Cache API strategy",
    (method) => {
      const listener = loadFetchListener();
      const respondWith = vi.fn();

      listener({
        request: new Request("http://127.0.0.1:5173/backups", { method }),
        respondWith,
      });

      expect(respondWith).not.toHaveBeenCalled();
    },
  );

  it("continues to intercept checkoff mutations for the offline queue", () => {
    const listener = loadFetchListener();
    const respondWith = vi.fn();

    listener({
      request: new Request("http://127.0.0.1:5173/printer-checkoff/reconcile", {
        method: "POST",
      }),
      respondWith,
    });

    expect(respondWith).toHaveBeenCalledOnce();
  });
});
