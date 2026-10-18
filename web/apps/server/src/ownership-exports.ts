import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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
type PlateRevision = { id: number; profileId: number };
const plateManifestSchema = z.object({
  format: z.literal("accepted-plate-3mf-manifest-v1"),
  basis: z.object({ profile_id: z.number(), plate_revision_id: z.number() }),
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

export function inspectOwnershipExports(root: string, profiles: readonly Profile[], plateRevisions: readonly PlateRevision[]): OwnershipExport[] {
  const result: OwnershipExport[] = [];
  const walk = (path: string, pieces: string[]) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (!isSafeRelativePath(name) || name.includes("/")) throw new Error("Unsafe export path");
        walk(join(path, name), [...pieces, name]);
      }
      return;
    }
    const [first] = pieces;
    const scoped = first?.startsWith("tenant-") === true;
    const layout = scoped ? pieces.slice(1) : pieces;
    const plate = layout[0] === "accepted-plates";
    const [plan, kind, filename] = plate ? [layout[1], "accepted-plates", layout.slice(3).join("/")] : layout;
    const profileId = (plate ? /^profile-([1-9][0-9]*)$/ : /^profile-([1-9][0-9]*)-.+$/).exec(plan ?? "")?.[1];
    const profile = profiles.find(profile => String(profile.id) === profileId);
    const tenant = profile?.tenantId;
    const expectedScope = tenant == null ? null : tenantExportDirectory("", tenant);
    if (!profile || (scoped && first !== expectedScope) || (!scoped && tenant !== "default")) throw new Error("Unassigned export artifact");
    if (plate) {
      const revisionId = /^revision-([1-9][0-9]*)$/.exec(layout[2] ?? "")?.[1];
      if (!plateRevisions.some(revision => String(revision.id) === revisionId && revision.profileId === profile.id)) throw new Error("Unassigned export artifact");
      if (!(layout.length === 4 && (filename === "manifest.json" || filename === "accepted-plates.zip"))
        && !(layout.length === 5 && /^plates\/[0-9]{4}\.3mf$/.test(filename))) throw new Error("Unsupported export artifact layout");
      const sha256 = ownershipFileDigest(path);
      if (filename === "manifest.json") {
        const { basis } = plateManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        if (basis.profile_id !== profile.id || String(basis.plate_revision_id) !== revisionId) throw new Error("Accepted Plate manifest basis mismatch");
      }
      result.push({ path: pieces.join("/"), sha256, profile_id: profile.id, tenant_id: profile.tenantId });
      return;
    }
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
