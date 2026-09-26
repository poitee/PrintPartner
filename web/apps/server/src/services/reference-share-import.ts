import { createHash } from "node:crypto";
import { scanRepo } from "@print-partner/domain";
import type { ReferenceShare } from "@print-partner/contracts";
import type { AppRepository, PlanDraftPartChoice } from "../db/repository.js";
import { saveKitManifest } from "./kit-manifest-store.js";
import { MAX_PLAN_DRAFT_PART_QUANTITY } from "./plan-drafts.js";

export type ReferenceDependencyStatus = "File required" | "Revision unverified" | "Ready";

export type ReferenceDependency = {
  source_key: string;
  path: string;
  status: ReferenceDependencyStatus;
};

export type ReferenceShareMapping = Record<string, number>;

export type ReferenceShareInspection = {
  dependencies: ReferenceDependency[];
  printable: boolean;
};

export type ReferenceShareImportResult = ReferenceShareInspection & {
  profile_id: number;
  profile_name: string;
  created: boolean;
};

export class ReferenceShareImportRefused extends Error {
  readonly dependencies: readonly ReferenceDependency[];

  constructor(dependencies: readonly ReferenceDependency[]) {
    super("Missing or unverified files cannot be imported as a printable Build.");
    this.name = "ReferenceShareImportRefused";
    this.dependencies = dependencies;
  }
}

function assertMapping(manifest: ReferenceShare, mapping: ReferenceShareMapping): void {
  const keys = new Set(manifest.sources.map((source) => source.key));
  const projects = new Set<number>();
  for (const [key, projectId] of Object.entries(mapping)) {
    if (!keys.has(key)) throw new Error("Mapping refers to an unknown source");
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("Mapping must use a Library Source id");
    if (projects.has(projectId)) throw new Error("Each reference must map to a different Library Source");
    projects.add(projectId);
  }
}

function presentPaths(localPath: string | null): Set<string> {
  if (!localPath) return new Set();
  return new Set(scanRepo(localPath).map((part) => part.relativePath));
}

function dependencyStatus(
  repo: AppRepository,
  manifest: ReferenceShare,
  mapping: ReferenceShareMapping,
  sourceKey: string,
  path: string,
  filesByProject: Map<number, Set<string>>,
): ReferenceDependencyStatus {
  const projectId = mapping[sourceKey];
  const project = projectId == null ? null : repo.getProjectRow(projectId);
  if (!project) return "File required";
  let files = filesByProject.get(project.id);
  if (!files) {
    files = presentPaths(project.localPath);
    filesByProject.set(project.id, files);
  }
  if (!files.has(path)) return "File required";
  const source = manifest.sources.find((entry) => entry.key === sourceKey);
  const expected = source?.revision.commit ?? null;
  const actual = project.lastCommitSha;
  if (expected && actual && expected.toLowerCase() === actual.toLowerCase()) return "Ready";
  return "Revision unverified";
}

export function inspectReferenceShare(
  repo: AppRepository,
  manifest: ReferenceShare,
  mapping: ReferenceShareMapping,
): ReferenceShareInspection {
  assertMapping(manifest, mapping);
  if (manifest.kind !== "build") return { dependencies: [], printable: false };
  const filesByProject = new Map<number, Set<string>>();
  const dependencies: ReferenceDependency[] = [];
  const seen = new Set<string>();
  for (const part of manifest.parts) {
    if (!part.included) continue;
    const id = `${part.source}\0${part.path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    dependencies.push({
      source_key: part.source,
      path: part.path,
      status: dependencyStatus(repo, manifest, mapping, part.source, part.path, filesByProject),
    });
  }
  return {
    dependencies,
    printable: dependencies.length > 0 && dependencies.every((entry) => entry.status === "Ready"),
  };
}

function receiptKey(manifest: ReferenceShare, mapping: ReferenceShareMapping): string {
  const mappingEntries = Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right));
  const digest = createHash("sha256").update(JSON.stringify({ manifest, mapping: mappingEntries })).digest("hex");
  return `reference-share.import.${digest}`;
}

function existingImport(
  repo: AppRepository,
  key: string,
): { profile_id: number; profile_name: string } | null {
  const id = Number(repo.getSetting(key));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const profile = repo.getOwnedProfileIdentity(id);
  return profile ? { profile_id: profile.id, profile_name: profile.name } : null;
}

function availableName(repo: AppRepository, title: string): string {
  const base = title.trim() || "Imported Build";
  const names = new Set(repo.listProfileHeaders().map((header) => header.name));
  if (!names.has(base)) return base;
  for (let index = 2; index <= 100; index += 1) {
    const candidate = `${base} (${index})`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error("A Build name is not available");
}

function projectIdsInOrder(manifest: Extract<ReferenceShare, { kind: "build" }>, mapping: ReferenceShareMapping): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const push = (sourceKey: string) => {
    const projectId = mapping[sourceKey];
    if (projectId == null || seen.has(projectId)) return;
    seen.add(projectId);
    ids.push(projectId);
  };
  for (const layer of manifest.layers) push(layer.source);
  for (const part of manifest.parts) {
    if (part.included) push(part.source);
  }
  return ids;
}

export function importReferenceShareBuild(
  repo: AppRepository,
  manifest: ReferenceShare,
  mapping: ReferenceShareMapping,
): ReferenceShareImportResult {
  if (manifest.kind !== "build") throw new Error("Only a Build manifest can be added to Builds");
  const inspection = inspectReferenceShare(repo, manifest, mapping);
  if (!inspection.printable) throw new ReferenceShareImportRefused(inspection.dependencies);
  const key = receiptKey(manifest, mapping);
  return repo.transaction(() => {
    const existing = existingImport(repo, key);
    if (existing) {
      return { ...existing, created: false, printable: true, dependencies: inspection.dependencies };
    }
    const ids = projectIdsInOrder(manifest, mapping);
    const first = ids[0];
    if (first == null) throw new Error("A printable Build needs a mapped Source");
    const profile = repo.createProfile(availableName(repo, manifest.title));
    repo.setBaseLayer(profile.id, first);
    for (const projectId of ids.slice(1)) repo.addAddonLayer(profile.id, projectId);
    saveKitManifest(repo, profile.id, {
      name: manifest.title,
      selections: manifest.selections,
      include: [...manifest.include],
      exclude: [...manifest.exclude],
      replacements: { ...manifest.replacements },
    });
    const included = new Map<number, Set<string>>(ids.map((id) => [id, new Set<string>()]));
    const partChoices = new Map<number, Map<string, PlanDraftPartChoice>>();
    for (const part of manifest.parts) {
      if (!part.included) continue;
      const projectId = mapping[part.source];
      if (projectId == null) continue;
      if (part.quantity < 1 || part.quantity > MAX_PLAN_DRAFT_PART_QUANTITY ||
          !part.role.trim() || part.role.length > 200) {
        throw new Error("Reference part quantity or role cannot be used in a Plan");
      }
      const paths = included.get(projectId) ?? new Set<string>();
      if (paths.has(part.path)) throw new Error("Reference part is duplicated");
      paths.add(part.path);
      included.set(projectId, paths);
      const choices = partChoices.get(projectId) ?? new Map<string, PlanDraftPartChoice>();
      choices.set(part.path, { quantity: part.quantity, role: part.role, color: part.color });
      partChoices.set(projectId, choices);
    }
    const draft = repo.recomputePlanDraft({
      profileId: profile.id,
      actor: "system:reference-share",
      idempotencyKey: key,
      includedPathsBySourceId: included,
      applyManifest: false,
      partChoicesBySourceId: partChoices,
    });
    if (draft.kind !== "created" && draft.kind !== "existing") {
      throw new Error(`Reference import could not prepare a Working Plan (${draft.kind})`);
    }
    repo.setSetting(key, String(profile.id));
    return {
      profile_id: profile.id,
      profile_name: profile.name,
      created: true,
      printable: true,
      dependencies: inspection.dependencies,
    };
  }, "immediate");
}
