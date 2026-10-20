import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readZipDirectory } from "./services/zip-directory.js";
import { tenantExportDirectory } from "./lib/secure-path.js";
import { isSafeRelativePath } from "./db/accepted-plan-operational-model.js";

export const ownershipExportClaimSchema = z.strictObject({
  path: z.string().refine(isSafeRelativePath),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  profile_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  user_id: z.string().min(1).max(256).refine(value => value !== "default"),
});
export type OwnershipExport = { path: string; sha256: string; profile_id: number; tenant_id: string };
type Profile = { id: number; tenantId: string };
type ExportRevision = { id: number; profileId: number };
const MAX_OWNERSHIP_STL_FILES = 10_000;
const plateManifestSchema = z.object({
  format: z.literal("accepted-plate-3mf-manifest-v1"),
  basis: z.object({ profile_id: z.number(), plate_revision_id: z.number() }),
  plates: z.array(z.object({ ordinal: z.number().int().positive(), entry: z.string() })).min(1),
});

export function ownershipFileDigest(path: string): string {
  if (!lstatSync(path).isFile()) throw new Error("Expected regular file without symlinks");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Expected regular artifact file");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export function inspectOwnershipExports(root: string, profiles: readonly Profile[], plateRevisions: readonly ExportRevision[], planRevisions: readonly ExportRevision[] = []): OwnershipExport[] {
  const result: OwnershipExport[] = [];
  const owner = (pieces: string[], plan: string | undefined, pattern: RegExp) => {
    const [first] = pieces;
    const profileId = pattern.exec(plan ?? "")?.[1];
    const profile = profiles.find(profile => String(profile.id) === profileId);
    const tenant = profile?.tenantId;
    const expectedScope = tenant == null ? null : tenantExportDirectory("", tenant);
    const scoped = first?.startsWith("tenant-") === true;
    if (!profile || (scoped && first !== expectedScope) || (!scoped && tenant !== "default")) throw new Error("Unassigned export artifact");
    return profile;
  };
  const plateTree = (path: string, pieces: string[], layout: string[]) => {
    const profile = owner(pieces, layout[1], /^profile-([1-9][0-9]*)$/);
    const revisionId = /^revision-([1-9][0-9]*)$/.exec(layout[2] ?? "")?.[1];
    if (!plateRevisions.some(revision => String(revision.id) === revisionId && revision.profileId === profile.id)) throw new Error("Unassigned export artifact");
    ownershipFileDigest(join(path, "manifest.json"));
    const { basis, plates } = plateManifestSchema.parse(JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")));
    if (basis.profile_id !== profile.id || String(basis.plate_revision_id) !== revisionId) throw new Error("Accepted Plate manifest basis mismatch");
    if (plates.some(plate => plate.entry !== `plates/${String(plate.ordinal).padStart(4, "0")}.3mf`)) throw new Error("Unsupported export artifact layout");
    const expected = ["accepted-plates.zip", "manifest.json", ...plates.map(plate => plate.entry)].sort();
    const actual: string[] = [];
    for (const name of readdirSync(path).sort()) {
      if (name === "plates" && lstatSync(join(path, name)).isDirectory()) actual.push(...readdirSync(join(path, name)).sort().map(entry => `plates/${entry}`));
      else actual.push(name);
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Incomplete or unexpected accepted Plate export tree");
    for (const file of expected) result.push({ path: [...pieces, file].join("/"), sha256: ownershipFileDigest(join(path, file)), profile_id: profile.id, tenant_id: profile.tenantId });
  };
  const stlTree = (path: string, pieces: string[], layout: string[]) => {
    const profile = owner(pieces, layout[1], /^profile-([1-9][0-9]*)$/);
    if (!/^(all|missing)$/.test(layout[3] ?? "") || !/^(color|color_dir)$/.test(layout[4] ?? "")
      || !/^content-[a-f0-9]{64}$/.test(layout[5] ?? "")) throw new Error("Unsupported export artifact layout");
    if (layout[2] === "empty" && readdirSync(path).length === 0) return;
    const revisionId = /^revision-([1-9][0-9]*)$/.exec(layout[2] ?? "")?.[1];
    if (!planRevisions.some(revision => String(revision.id) === revisionId && revision.profileId === profile.id)) throw new Error("Unassigned export artifact");
    if (readdirSync(path).length === 0) return;
    const files = new Map<string, number>();
    const collect = (directory: string, prefix: string[]) => {
      const entries = readdirSync(directory).sort();
      if (entries.length === 0) throw new Error("Empty accepted STL export directory");
      for (const name of entries) {
        if (!isSafeRelativePath(name) || name.includes("/")) throw new Error("Unsafe export path");
        const segments = [...prefix, name];
        const file = join(directory, name);
        const stat = lstatSync(file);
        if (stat.isDirectory() && segments.length <= 2) { collect(file, segments); continue; }
        const relative = segments.join("/");
        if (!stat.isFile() || !(relative === "accepted-stl.zip" || (segments.length >= 2 && segments.length <= 3 && name.endsWith(".stl")))) throw new Error("Unsupported accepted STL export entry");
        if (files.size >= MAX_OWNERSHIP_STL_FILES + 1) throw new Error("Too many accepted STL export files");
        files.set(relative, stat.size);
        result.push({ path: [...pieces, relative].join("/"), sha256: ownershipFileDigest(file), profile_id: profile.id, tenant_id: profile.tenantId });
      }
    };
    collect(path, []);
    if (!files.has("accepted-stl.zip")) throw new Error("Missing accepted STL bundle");
    const entries = readZipDirectory(join(path, "accepted-stl.zip"), MAX_OWNERSHIP_STL_FILES);
    if (entries.length === 0 || entries.length + 1 !== files.size
      || entries.some(entry => entry.name === "accepted-stl.zip" || files.get(entry.name) !== entry.size)) throw new Error("Incomplete or unexpected accepted STL export tree");
  };
  const walk = (path: string, pieces: string[]) => {
    const stat = lstatSync(path);
    const layout = pieces[0]?.startsWith("tenant-") === true ? pieces.slice(1) : pieces;
    if (stat.isDirectory() && layout[0] === "accepted-stl" && layout.length === 6) return stlTree(path, pieces, layout);
    if (stat.isDirectory() && layout[0] === "accepted-plates" && layout.length === 3) return plateTree(path, pieces, layout);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (!isSafeRelativePath(name) || name.includes("/")) throw new Error("Unsafe export path");
        walk(join(path, name), [...pieces, name]);
      }
      return;
    }
    const [plan, kind, filename] = layout;
    const profile = owner(pieces, plan, /^profile-([1-9][0-9]*)-.+$/);
    if (layout.length !== 3 || !filename || !(
      (kind === "checklist" && /^checklist-[a-f0-9]{64}\.html$/.test(filename))
      || (kind === "direct-3mf" && /^direct-[a-f0-9]{16}\.3mf$/.test(filename))
      || (kind === "kit" && /^.+-[0-9]{8}T[0-9]{6}-[a-f0-9]{64}\.print-partner-kit\.zip$/.test(filename))
    )) throw new Error("Unsupported export artifact layout");
    const sha256 = ownershipFileDigest(path);
    if (kind === "checklist" && filename !== `checklist-${sha256}.html`) throw new Error("Export content digest mismatch");
    if (kind === "direct-3mf" && filename !== `direct-${sha256.slice(0, 16)}.3mf`) throw new Error("Export content digest mismatch");
    if (kind === "kit" && !filename.endsWith(`-${sha256}.print-partner-kit.zip`)) throw new Error("Export content digest mismatch");
    result.push({ path: pieces.join("/"), sha256, profile_id: profile.id, tenant_id: profile.tenantId });
  };
  if (!lstatSync(root).isDirectory()) throw new Error("Export root must be a directory");
  walk(root, []);
  return result;
}

export function ownershipExportTarget(artifact: OwnershipExport, owner: string): string {
  const pieces = artifact.path.split("/");
  const layout = pieces[0]?.startsWith("tenant-") ? pieces.slice(1) : pieces;
  return join(tenantExportDirectory("exports", owner), ...layout);
}
