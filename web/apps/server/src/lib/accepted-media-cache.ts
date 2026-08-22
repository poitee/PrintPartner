import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";

export type AcceptedMediaVariant = "mesh" | "thumbnail" | "preview";

export type AcceptedMediaBasisInput = {
  readonly expectedSha256: string;
  readonly role: string;
  readonly hex: string | null;
  readonly variant: AcceptedMediaVariant;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const ACCEPTED_MEDIA_PNG_MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MEDIA_READ_ATTEMPTS = 8;

function normalizedRole(value: string): string {
  const role = value.trim().toLowerCase();
  if (!role || role.includes("\0")) throw new Error("Invalid accepted media role");
  return role;
}

function normalizedHex(value: string | null): string {
  if (value == null || !value.trim()) return "";
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new Error("Invalid accepted media color");
  return `#${hex}`;
}

export function acceptedMediaBasis(input: AcceptedMediaBasisInput): string {
  if (!SHA256_PATTERN.test(input.expectedSha256)) {
    throw new Error("Invalid accepted artifact digest");
  }
  const payload = [
    "accepted-media-v1",
    input.variant,
    input.expectedSha256,
    normalizedRole(input.role),
    normalizedHex(input.hex),
  ].join("\0");
  return createHash("sha256").update(payload).digest("hex");
}

function validatedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < PNG_SIGNATURE.length) {
    throw new Error("Invalid accepted media PNG limit");
  }
  return value;
}

function validatePng(png: Buffer, maxBytes: number): void {
  if (png.length > maxBytes) throw new Error("Accepted media PNG exceeds size limit");
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid accepted media PNG");
  }
}

export function acceptedMediaCachePath(input: {
  readonly thumbsDir: string;
  readonly basis: string;
}): string {
  if (!SHA256_PATTERN.test(input.basis)) throw new Error("Invalid accepted media basis");
  return join(resolve(input.thumbsDir), `${input.basis}.png`);
}

type ReadAcceptedMediaPngInput = {
  readonly thumbsDir: string;
  readonly basis: string;
  readonly maxBytes?: number;
};

export type AcceptedMediaPngObservation =
  | { readonly kind: "present" }
  | { readonly kind: "missing" };

type AcceptedMediaPngReadResult =
  | { readonly status: "found"; readonly png: Buffer }
  | { readonly status: "retryable_race" }
  | { readonly status: "miss" };

type AcceptedMediaDescriptorResult =
  | {
      readonly status: "opened";
      readonly descriptor: number;
      readonly stats: Stats;
    }
  | { readonly status: "retryable_race" }
  | { readonly status: "miss" };

function isRenameWindowError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ELOOP")
  );
}

function openAcceptedMediaPngDescriptor(input: {
  readonly thumbsDir: string;
  readonly path: string;
  readonly maxBytes: number;
}): AcceptedMediaDescriptorResult {
  let descriptor: number | null = null;
  try {
    const rootStats = lstatSync(resolve(input.thumbsDir));
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return { status: "miss" };
    const beforeOpen = lstatSync(input.path);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) return { status: "miss" };
    if (beforeOpen.size < PNG_SIGNATURE.length || beforeOpen.size > input.maxBytes) {
      return { status: "miss" };
    }

    try {
      descriptor = openSync(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      return { status: isRenameWindowError(error) ? "retryable_race" : "miss" };
    }
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== beforeOpen.dev ||
      opened.ino !== beforeOpen.ino ||
      opened.size !== beforeOpen.size
    ) {
      return { status: "retryable_race" };
    }

    const openedDescriptor = descriptor;
    descriptor = null;
    return { status: "opened", descriptor: openedDescriptor, stats: opened };
  } catch {
    return { status: "miss" };
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

function descriptorStayedStable(
  descriptor: number,
  opened: Stats,
): boolean {
  const afterRead = fstatSync(descriptor);
  return (
    afterRead.dev === opened.dev &&
    afterRead.ino === opened.ino &&
    afterRead.size === opened.size &&
    afterRead.mtimeMs === opened.mtimeMs &&
    afterRead.ctimeMs === opened.ctimeMs
  );
}

function readAcceptedMediaPngOnce(input: {
  readonly thumbsDir: string;
  readonly path: string;
  readonly maxBytes: number;
}): AcceptedMediaPngReadResult {
  const opened = openAcceptedMediaPngDescriptor(input);
  if (opened.status !== "opened") return opened;
  try {
    const png = Buffer.alloc(opened.stats.size);
    let position = 0;
    while (position < png.length) {
      const bytesRead = readSync(
        opened.descriptor,
        png,
        position,
        png.length - position,
        position,
      );
      if (bytesRead === 0) return { status: "retryable_race" };
      position += bytesRead;
    }
    if (!descriptorStayedStable(opened.descriptor, opened.stats)) {
      return { status: "retryable_race" };
    }
    validatePng(png, input.maxBytes);
    return { status: "found", png };
  } catch {
    return { status: "miss" };
  } finally {
    closeSync(opened.descriptor);
  }
}

function observeAcceptedMediaPngOnce(input: {
  readonly thumbsDir: string;
  readonly path: string;
  readonly maxBytes: number;
}): Exclude<AcceptedMediaPngReadResult, { readonly status: "found" }> | { readonly status: "found" } {
  const opened = openAcceptedMediaPngDescriptor(input);
  if (opened.status !== "opened") return opened;
  try {
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    if (
      readSync(opened.descriptor, signature, 0, signature.length, 0) !== signature.length
    ) {
      return { status: "retryable_race" };
    }
    if (!descriptorStayedStable(opened.descriptor, opened.stats)) {
      return { status: "retryable_race" };
    }
    return signature.equals(PNG_SIGNATURE) ? { status: "found" } : { status: "miss" };
  } catch {
    return { status: "miss" };
  } finally {
    closeSync(opened.descriptor);
  }
}

export function observeAcceptedMediaPng(
  input: ReadAcceptedMediaPngInput,
): AcceptedMediaPngObservation {
  const maxBytes = validatedLimit(input.maxBytes ?? ACCEPTED_MEDIA_PNG_MAX_BYTES);
  const path = acceptedMediaCachePath(input);
  for (let attempt = 0; attempt < ACCEPTED_MEDIA_READ_ATTEMPTS; attempt += 1) {
    const result = observeAcceptedMediaPngOnce({ thumbsDir: input.thumbsDir, path, maxBytes });
    if (result.status === "found") return { kind: "present" };
    if (result.status === "miss") return { kind: "missing" };
  }
  return { kind: "missing" };
}

export function readAcceptedMediaPng(input: ReadAcceptedMediaPngInput): Buffer | null {
  const maxBytes = validatedLimit(input.maxBytes ?? ACCEPTED_MEDIA_PNG_MAX_BYTES);
  const path = acceptedMediaCachePath(input);
  for (let attempt = 0; attempt < ACCEPTED_MEDIA_READ_ATTEMPTS; attempt += 1) {
    const result = readAcceptedMediaPngOnce({ thumbsDir: input.thumbsDir, path, maxBytes });
    if (result.status === "found") return result.png;
    if (result.status === "miss") return null;
  }
  return null;
}

export function removeAcceptedMediaPng(input: {
  readonly thumbsDir: string;
  readonly basis: string;
}): boolean {
  const path = acceptedMediaCachePath(input);
  try {
    const rootStats = lstatSync(resolve(input.thumbsDir));
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }

  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function writeAcceptedMediaPng(input: {
  readonly thumbsDir: string;
  readonly basis: string;
  readonly png: Buffer;
  readonly maxBytes?: number;
}): void {
  const maxBytes = validatedLimit(input.maxBytes ?? ACCEPTED_MEDIA_PNG_MAX_BYTES);
  validatePng(input.png, maxBytes);
  const root = resolve(input.thumbsDir);
  const target = acceptedMediaCachePath(input);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Invalid accepted media cache root");
  }
  const temporary = join(root, `.${input.basis}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | null = null;
  let renamed = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let position = 0;
    while (position < input.png.length) {
      const bytesWritten = writeSync(
        descriptor,
        input.png,
        position,
        input.png.length - position,
        position,
      );
      if (bytesWritten === 0) throw new Error("Accepted media PNG write made no progress");
      position += bytesWritten;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
    renamed = true;
  } finally {
    if (descriptor != null) closeSync(descriptor);
    if (!renamed) rmSync(temporary, { force: true });
  }
}
