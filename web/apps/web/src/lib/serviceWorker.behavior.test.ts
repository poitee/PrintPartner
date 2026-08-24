import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type FetchEvent = {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
};

type WorkerListener = (event: FetchEvent) => void;

class MemoryCache {
  private readonly responses = new Map<string, Response>();

  async addAll(): Promise<void> {}

  async match(request: Request | string): Promise<Response | undefined> {
    const key = typeof request === "string" ? request : request.url;
    return this.responses.get(key)?.clone();
  }

  async put(request: Request | string, response: Response): Promise<void> {
    const key = typeof request === "string" ? request : request.url;
    this.responses.set(key, response.clone());
  }

  async delete(request: Request | string): Promise<boolean> {
    const key = typeof request === "string" ? request : request.url;
    return this.responses.delete(key);
  }
}

function loadWorker(fetchImpl: (request: Request) => Promise<Response>) {
  const listeners = new Map<string, WorkerListener>();
  const cacheEntries = new Map<string, MemoryCache>();
  const caches = {
    async open(name: string) {
      const existing = cacheEntries.get(name);
      if (existing) return existing;
      const created = new MemoryCache();
      cacheEntries.set(name, created);
      return created;
    },
    async keys() {
      return [...cacheEntries.keys()];
    },
    async delete(name: string) {
      return cacheEntries.delete(name);
    },
  };
  const self = {
    location: { origin: "https://print-partner.test" },
    addEventListener(type: string, listener: WorkerListener) {
      listeners.set(type, listener);
    },
    skipWaiting: async () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
    },
    registration: {},
  };

  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    URL,
    Request,
    Response,
    caches,
    fetch: fetchImpl,
    self,
  });

  async function dispatchFetch(pathname: string): Promise<Response> {
    const listener = listeners.get("fetch");
    if (!listener) throw new Error("Service worker did not register a fetch listener");
    let response: Promise<Response> | Response | undefined;
    listener({
      request: new Request(`https://print-partner.test${pathname}`),
      respondWith(nextResponse) {
        response = nextResponse;
      },
    });
    return response ? await response : fetchImpl(new Request(`https://print-partner.test${pathname}`));
  }

  return { dispatchFetch };
}

describe("service worker request isolation", () => {
  it("always reads mutable API responses from the network", async () => {
    let revision = 0;
    const worker = loadWorker(async () =>
      Response.json({ revision: ++revision }),
    );

    await expect(worker.dispatchFetch("/sources").then((response) => response.json())).resolves.toEqual({
      revision: 1,
    });
    await expect(worker.dispatchFetch("/sources").then((response) => response.json())).resolves.toEqual({
      revision: 2,
    });
  });

  it("does not expose one signed-in user's auth response to the next session", async () => {
    let userId = "user-a";
    const worker = loadWorker(async () => Response.json({ userId }));

    await expect(worker.dispatchFetch("/auth/me").then((response) => response.json())).resolves.toEqual({
      userId: "user-a",
    });
    userId = "user-b";
    await expect(worker.dispatchFetch("/auth/me").then((response) => response.json())).resolves.toEqual({
      userId: "user-b",
    });
  });
});
