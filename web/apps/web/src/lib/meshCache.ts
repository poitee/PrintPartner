const DB_NAME = "PrintPartnerMeshCache";
const STORE_NAME = "meshes";
const DB_VERSION = 2;
const MAX_CACHED_MESHES = 50;
const BASIS_PATTERN = /^[0-9a-f]{64}$/;

interface CachedMesh {
  basis: string;
  buffer: ArrayBuffer;
  timestamp: number;
}

function isCachedMesh(value: unknown): value is CachedMesh {
  return (
    typeof value === "object" &&
    value !== null &&
    "basis" in value &&
    typeof value.basis === "string" &&
    BASIS_PATTERN.test(value.basis) &&
    "buffer" in value &&
    value.buffer instanceof ArrayBuffer &&
    "timestamp" in value &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp)
  );
}

let dbInstance: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;

    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(req.error);
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("IndexedDB upgrade blocked"));
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => {
        db.close();
        if (dbInstance === db) dbInstance = null;
      };
      dbInstance = db;
      resolve(db);
    };

    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
      const store = db.createObjectStore(STORE_NAME, { keyPath: "basis" });
      store.createIndex("timestamp", "timestamp", { unique: false });
    };
  });
}

export async function getCachedMeshBuffer(basis: string): Promise<ArrayBuffer | null> {
  if (!BASIS_PATTERN.test(basis)) return null;
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(basis);

      req.onsuccess = () => {
        resolve(isCachedMesh(req.result) ? req.result.buffer : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheMeshBuffer(
  basis: string,
  buffer: ArrayBuffer,
): Promise<void> {
  if (!BASIS_PATTERN.test(basis) || buffer.byteLength === 0) return;
  try {
    const db = await openDB();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put({
        basis,
        buffer,
        timestamp: Date.now(),
      });

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (count > MAX_CACHED_MESHES) {
      await evictOldest(db);
    }
  } catch {
    return;
  }
}

async function evictOldest(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("timestamp");

    const req = index.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const deleteReq = cursor.delete();
      deleteReq.onerror = () => reject(deleteReq.error);
      deleteReq.onsuccess = () => resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearMeshCache(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    return;
  }
}
