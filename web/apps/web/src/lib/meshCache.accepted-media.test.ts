import { afterEach, describe, expect, it, vi } from "vitest";

const basis = "b".repeat(64);

describe("accepted mesh cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("replaces the Part-ID store and keys records by accepted basis", async () => {
    const deletedStores: string[] = [];
    const createdStores: Array<{ name: string; keyPath: string }> = [];
    const requestedKeys: unknown[] = [];
    const storedRecords: unknown[] = [];
    class FakeRequest {
      readonly error = null;
      onsuccess: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(readonly result: unknown) {}
    }
    const request = (result: unknown) => {
      const value = new FakeRequest(result);
      queueMicrotask(() => value.onsuccess?.());
      return value;
    };
    const store = {
      createIndex: vi.fn(),
      get(key: unknown) {
        requestedKeys.push(key);
        return request(undefined);
      },
      put(value: unknown) {
        storedRecords.push(value);
        return request(undefined);
      },
      count() {
        return request(1);
      },
      index() {
        return { openCursor: () => request(null) };
      },
      clear() {
        return request(undefined);
      },
    };
    const db = {
      objectStoreNames: { contains: () => true },
      deleteObjectStore(name: string) {
        deletedStores.push(name);
      },
      createObjectStore(name: string, options: { keyPath: string }) {
        createdStores.push({ name, keyPath: options.keyPath });
        return store;
      },
      transaction() {
        return {
          objectStore: () => store,
          error: null,
          oncomplete: null,
          onerror: null,
        };
      },
    };
    const versions: number[] = [];
    class FakeOpenRequest {
      readonly error = null;
      onsuccess: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onblocked: (() => void) | null = null;
      onupgradeneeded: ((event: { target: FakeOpenRequest }) => void) | null = null;

      constructor(readonly result: typeof db) {}
    }
    vi.stubGlobal("indexedDB", {
      open(_name: string, version: number) {
        versions.push(version);
        const value = new FakeOpenRequest(db);
        queueMicrotask(() => {
          value.onupgradeneeded?.({ target: value });
          value.onsuccess?.();
        });
        return value;
      },
    });
    const { cacheMeshBuffer, getCachedMeshBuffer } = await import("./meshCache");

    await getCachedMeshBuffer(basis);
    await cacheMeshBuffer(basis, new ArrayBuffer(4));

    expect(versions).toEqual([2]);
    expect(deletedStores).toEqual(["meshes"]);
    expect(createdStores).toEqual([{ name: "meshes", keyPath: "basis" }]);
    expect(requestedKeys).toEqual([basis]);
    expect(storedRecords).toEqual([
      expect.objectContaining({ basis, buffer: expect.any(ArrayBuffer) }),
    ]);
  });

  it("settles as a cache miss when an IndexedDB upgrade is blocked", async () => {
    const close = vi.fn();
    const db = { close, onversionchange: null as (() => void) | null };
    const request = {
      result: db,
      error: null,
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onblocked: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
    };
    vi.stubGlobal("indexedDB", {
      open() {
        queueMicrotask(() => request.onblocked?.());
        return request;
      },
    });
    const { getCachedMeshBuffer } = await import("./meshCache");

    await expect(getCachedMeshBuffer(basis)).resolves.toBeNull();
    request.onsuccess?.();

    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a successful database connection when its version changes", async () => {
    const close = vi.fn();
    const getRequest = {
      result: undefined,
      error: null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    const db = {
      objectStoreNames: { contains: () => true },
      close,
      onversionchange: null as (() => void) | null,
      transaction() {
        return { objectStore: () => ({ get: () => getRequest }) };
      },
    };
    const request = {
      result: db,
      error: null,
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onblocked: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
    };
    vi.stubGlobal("indexedDB", {
      open() {
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    });
    const { getCachedMeshBuffer } = await import("./meshCache");
    const result = getCachedMeshBuffer(basis);
    await vi.waitFor(() => expect(getRequest.onsuccess).toBeTypeOf("function"));
    getRequest.onsuccess?.();
    await expect(result).resolves.toBeNull();

    db.onversionchange?.();

    expect(close).toHaveBeenCalledOnce();
  });
});
