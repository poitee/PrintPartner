import * as THREE from "three";
import { DEFAULT_FILAMENT_HEX } from "./colorPresets";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import {
  acceptedPartMediaMetadata,
  acceptedPartMediaRevalidationHeaders,
  partMeshUrl,
  uploadPartThumbnail,
} from "../api/engine.js";
import { fetchWithRetry } from "./fetchWithRetry.js";
import { getCachedMeshBuffer, cacheMeshBuffer } from "./meshCache.js";

const SIZE = 256;
const DEFAULT_COLOR = DEFAULT_FILAMENT_HEX;
const MESH_CACHE_MAX = 48;
const BLOB_CACHE_MAX = 96;
const MAX_FETCH_ATTEMPTS = 3;

let sharedRenderer: THREE.WebGLRenderer | null = null;
let sharedLoader: STLLoader | null = null;

type CachedMesh = {
  buffer: ArrayBuffer;
  lastUsed: number;
};

const meshBufferCache = new Map<string, CachedMesh>();
const currentBasisByPartId = new Map<number, string>();

function currentBasis(partId: number): string | null {
  const basis = currentBasisByPartId.get(partId);
  if (basis == null) return null;
  currentBasisByPartId.delete(partId);
  currentBasisByPartId.set(partId, basis);
  return basis;
}

function rememberCurrentBasis(partId: number, basis: string): void {
  currentBasisByPartId.delete(partId);
  currentBasisByPartId.set(partId, basis);
  if (currentBasisByPartId.size <= MESH_CACHE_MAX) return;
  const oldestPartId = currentBasisByPartId.keys().next().value;
  if (oldestPartId != null) currentBasisByPartId.delete(oldestPartId);
}

function optionalAcceptedPartMediaMetadata(response: Response) {
  try {
    return acceptedPartMediaMetadata(response);
  } catch {
    return null;
  }
}

/** Reuse one WebGL context because browsers cap the number of live contexts. */
function getRenderer(): THREE.WebGLRenderer {
  if (!sharedRenderer) {
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    sharedRenderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    sharedRenderer.setPixelRatio(1);
    sharedRenderer.setSize(SIZE, SIZE, false);
  }
  return sharedRenderer;
}

function rememberMeshBuffer(basis: string, buffer: ArrayBuffer): void {
  meshBufferCache.set(basis, { buffer, lastUsed: Date.now() });
  if (meshBufferCache.size <= MESH_CACHE_MAX) return;
  let oldestBasis: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [id, entry] of meshBufferCache) {
    if (entry.lastUsed < oldestAt) {
      oldestAt = entry.lastUsed;
      oldestBasis = id;
    }
  }
  if (oldestBasis != null) meshBufferCache.delete(oldestBasis);
}

function cachedMeshBuffer(basis: string): ArrayBuffer | null {
  const hit = meshBufferCache.get(basis);
  if (!hit) return null;
  hit.lastUsed = Date.now();
  return hit.buffer;
}

type BlobEntry = { blob: Blob; lastUsed: number };
const blobCache = new Map<string, BlobEntry>();

function blobCacheKey(basis: string, hex: string): string {
  return `${basis}:${hex.toLowerCase().replace(/^#/, "")}`;
}

function getCachedBlob(basis: string, hex: string): Blob | null {
  const entry = blobCache.get(blobCacheKey(basis, hex));
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry.blob;
}

function rememberBlob(basis: string, hex: string, blob: Blob): void {
  blobCache.set(blobCacheKey(basis, hex), { blob, lastUsed: Date.now() });
  if (blobCache.size <= BLOB_CACHE_MAX) return;
  let oldestKey: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of blobCache) {
    if (entry.lastUsed < oldestAt) {
      oldestAt = entry.lastUsed;
      oldestKey = key;
    }
  }
  if (oldestKey != null) blobCache.delete(oldestKey);
}

export function decimateGeometryForThumbnail(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  // Plan thumbnails must represent the accepted STL exactly. Earlier thumbnail
  // decimation sampled triangles from large meshes, which made detailed models
  // appear broken even though the source geometry was valid.
  return geometry;
}

function renderBufferToBlob(buffer: ArrayBuffer, hex: string): Promise<Blob | null> {
  const renderer = getRenderer();
  const loader = (sharedLoader ??= new STLLoader());
  let geometry = loader.parse(buffer);
  geometry = decimateGeometryForThumbnail(geometry);
  geometry.center();
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  const dims = new THREE.Vector3();
  geometry.boundingBox?.getSize(dims);
  const maxDim = Math.max(dims.x, dims.y, dims.z, 1);

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex || DEFAULT_COLOR),
    metalness: 0.15,
    roughness: 0.65,
  });
  const mesh = new THREE.Mesh(geometry, material);

  const scene = new THREE.Scene();
  scene.add(mesh);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(1, 1.2, 0.8);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(-0.8, 0.4, -1);
  scene.add(key, fill);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, maxDim * 20);
  camera.position.set(maxDim * 1.4, maxDim * 1.1, maxDim * 1.6);
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);

  return new Promise((resolve) => {
    renderer.domElement.toBlob((blob) => {
      geometry.dispose();
      material.dispose();
      resolve(blob);
    }, "image/png");
  });
}

class RenderQueue {
  private pending: Array<{
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    priority: number;
  }> = [];
  private active = 0;
  // Rendering and toBlob both use the shared canvas. Concurrent jobs can
  // overwrite one another before the previous capture completes.
  private readonly maxConcurrent = 1;

  enqueue<T>(task: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        priority,
      });
      this.pending.sort((a, b) => b.priority - a.priority);
      this.process();
    });
  }

  private process() {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) break;
      this.active++;
      item
        .task()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active--;
          this.process();
        });
    }
  }
}

const renderQueue = new RenderQueue();
const inFlightPartThumbnails = new Map<string, Promise<Blob | null>>();
const inFlightBlobRenders = new Map<string, Promise<Blob | null>>();

type BoundedReadResult =
  | { readonly kind: "loaded"; readonly buffer: ArrayBuffer }
  | { readonly kind: "retryable" }
  | { readonly kind: "rejected" };

async function readResponseBuffer(res: Response): Promise<BoundedReadResult> {
  const declared = res.headers.get("content-length");
  if (declared != null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n <= 0) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "rejected" };
    }
  }

  if (!res.body) {
    try {
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength === 0) return { kind: "retryable" };
      return { kind: "loaded", buffer };
    } catch {
      return { kind: "retryable" };
    }
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { kind: "retryable" };
  }

  if (total === 0) return { kind: "retryable" };
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "loaded", buffer: out.buffer };
}

type AcceptedMeshBuffer = {
  readonly basis: string;
  readonly renderHex: string | null;
  readonly buffer: ArrayBuffer;
};

export async function loadAcceptedMeshBuffer(
  partId: number,
): Promise<AcceptedMeshBuffer | null> {
  const knownBasis = currentBasis(partId);
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
    let res: Response;
    try {
      res = await fetchWithRetry(() => partMeshUrl(partId), {
        init: { headers: acceptedPartMediaRevalidationHeaders(knownBasis) },
        retryStatuses: [502, 503, 504],
      });
    } catch {
      continue;
    }
    if (res.status === 304) {
      const metadata = optionalAcceptedPartMediaMetadata(res);
      if (!metadata) return null;
      const memory = cachedMeshBuffer(metadata.basis);
      const persisted = memory ?? (await getCachedMeshBuffer(metadata.basis));
      if (persisted) {
        rememberMeshBuffer(metadata.basis, persisted);
        rememberCurrentBasis(partId, metadata.basis);
        return { ...metadata, buffer: persisted };
      }
      try {
        res = await fetchWithRetry(() => partMeshUrl(partId), {
          retryStatuses: [502, 503, 504],
        });
      } catch {
        continue;
      }
    }
    if (!res.ok) {
      if (res.status === 404 || res.status === 409 || res.status === 413) return null;
      continue;
    }
    const metadata = optionalAcceptedPartMediaMetadata(res);
    if (!metadata) return null;
    const read = await readResponseBuffer(res);
    if (read.kind === "rejected") return null;
    if (read.kind === "retryable") continue;
    const { buffer } = read;

    rememberCurrentBasis(partId, metadata.basis);
    rememberMeshBuffer(metadata.basis, buffer);
    void cacheMeshBuffer(metadata.basis, buffer).catch(() => {});
    return { ...metadata, buffer };
  }

  return null;
}

async function renderAcceptedMeshBlob(
  mesh: AcceptedMeshBuffer,
  resolvedHex: string,
  priority: number,
): Promise<Blob | null> {
  const cachedBlob = getCachedBlob(mesh.basis, resolvedHex);
  if (cachedBlob) return cachedBlob;

  const cacheKey = blobCacheKey(mesh.basis, resolvedHex);
  const existing = inFlightBlobRenders.get(cacheKey);
  if (existing) return existing;

  const render = renderQueue.enqueue(async () => {
    // Another queued Part may have rendered the same artifact and color while
    // this task waited for the shared canvas.
    const queuedCacheHit = getCachedBlob(mesh.basis, resolvedHex);
    if (queuedCacheHit) return queuedCacheHit;

    const blob = await renderBufferToBlob(mesh.buffer, resolvedHex);
    if (blob) rememberBlob(mesh.basis, resolvedHex, blob);
    return blob;
  }, priority);
  inFlightBlobRenders.set(cacheKey, render);

  try {
    return await render;
  } finally {
    if (inFlightBlobRenders.get(cacheKey) === render) {
      inFlightBlobRenders.delete(cacheKey);
    }
  }
}

export function generatePartThumbnail(
  partId: number,
  options?: { priority?: number; cacheVersion?: number },
): Promise<string | null> {
  const requestKey = `${partId}:${options?.cacheVersion ?? 0}`;
  const existing = inFlightPartThumbnails.get(requestKey);
  if (existing) {
    return existing.then((blob) => (blob ? URL.createObjectURL(blob) : null));
  }

  const render = (async () => {
    const mesh = await loadAcceptedMeshBuffer(partId);
    if (!mesh) return null;
    const resolvedHex = mesh.renderHex ?? DEFAULT_COLOR;

    let blob: Blob | null;
    try {
      // Mesh I/O and cache work can overlap across Parts. Only the shared
      // WebGL canvas render and capture must run one at a time. Render work is
      // also shared by different Parts that resolve to the same basis/color.
      blob = await renderAcceptedMeshBlob(mesh, resolvedHex, options?.priority ?? 0);
    } catch {
      return null;
    }
    if (!blob) return null;

    void uploadPartThumbnail(partId, blob, mesh.basis).catch(() => {});
    return blob;
  })();
  inFlightPartThumbnails.set(requestKey, render);
  return render
    .then((blob) => (blob ? URL.createObjectURL(blob) : null))
    .finally(() => {
      if (inFlightPartThumbnails.get(requestKey) === render) {
        inFlightPartThumbnails.delete(requestKey);
      }
    });
}
