import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { AppRepository } from "../db/repository.js";
import type { SourceArtifact } from "./source-artifacts.js";

export const BUILD_PLANNING_VERSION = 1;
const SETTING_PREFIX = "build_planning.v1.";

export type RequirementStatus =
  "unverified" | "satisfied" | "incompatible" | "user_waived";
export type EvidenceKind =
  | "canonical_design"
  | "vendor_overlay"
  | "mod"
  | "component"
  | "model_source"
  | "informational_evidence";
export type DifferenceKind =
  "added" | "removed" | "changed" | "renamed" | "contradictory";
export type DifferenceResolution =
  | "choose_source_a"
  | "choose_source_b"
  | "include_both"
  | "not_applicable"
  | "custom";

export type BuildRequirement = {
  key: string;
  value: string;
  status: RequirementStatus;
  detail?: string;
};

export type BuildEvidence = {
  id: string;
  url: string;
  normalized_url: string;
  kind: EvidenceKind;
  input_kind?: "url" | "model_page" | "upload";
  filenames?: string[];
  artifacts?: SourceArtifact[];
  upload_required?: boolean;
  derived_from_evidence_id?: string;
  source_id?: number;
  source_role?: "structural_base" | "overlay" | "addon" | "evidence";
  title?: string;
  extract?: string;
  retrieved_at?: string;
  content_hash?: string;
  sync_status?: "pending" | "synced" | "failed";
  pinned_revision?: string;
};

export type BuildDifference = {
  id: string;
  group_id: string;
  family: string;
  kind: DifferenceKind;
  source_a: string;
  source_b: string;
  path_a?: string;
  path_b?: string;
  detail: string;
};

export type DifferenceGroupResolution = {
  resolution: DifferenceResolution;
  rationale: string;
  custom_resolution?: string;
  resolved_at: string;
};

export type RoleFilamentAssignment = {
  role: string;
  requested_brand?: string;
  requested_name?: string;
  inventory_kind: "catalog" | "spoolman" | "custom" | "substitute";
  inventory_id?: string;
  color_hex: string;
  substitution_confirmed: boolean;
};

export type SourceContribution = {
  id: string;
  evidence_id: string;
  slot: string;
  responsibility: "printable_parts" | "hardware_constraint" | "informational_evidence";
  path_scopes: string[];
  confidence: "low" | "medium" | "high";
  evidence_text: string;
  status: "proposed" | "confirmed" | "rejected";
};

export type CompatibilityFinding = {
  id: string;
  subject: string;
  status: RequirementStatus;
  detail: string;
  evidence_ids: string[];
};

export type BuildChecklistItem = {
  id: string;
  title: string;
  detail?: string;
  category: "test_fit" | "wiring" | "safety" | "pre_print" | "other";
  required: boolean;
  completed: boolean;
};

export type BuildPlanningBrief = {
  version: typeof BUILD_PLANNING_VERSION;
  build_id: number;
  special_request: string;
  requirements: BuildRequirement[];
  evidence: BuildEvidence[];
  contributions: SourceContribution[];
  compatibility_findings?: CompatibilityFinding[];
  differences: BuildDifference[];
  resolutions: Record<string, DifferenceGroupResolution>;
  role_filaments: RoleFilamentAssignment[];
  checklist_items?: BuildChecklistItem[];
  managed_source_ids?: number[];
  draft_source_revisions?: Record<string, string>;
  draft_id?: number;
  draft_review_blockers: string[];
  created_at: string;
  updated_at: string;
};

/** MCP clients receive Preparation facts, never the legacy publication-gate field. */
export function mcpBuildPlanningBrief(
  brief: BuildPlanningBrief,
): Omit<BuildPlanningBrief, "draft_review_blockers"> {
  const { draft_review_blockers: _legacyPublicationGates, ...planningBrief } = brief;
  return planningBrief;
}

export type BuildPlanningReadiness = {
  ready: boolean;
  blockers: Array<{ code: string; detail: string }>;
};

export type BuildPlanningPhase =
  | { readonly kind: "preparing" }
  | { readonly kind: "draft"; readonly draft_id: number }
  | {
      readonly kind: "applied";
      readonly draft_id: number;
      readonly revision_id: number | null;
    }
  | { readonly kind: "abandoned"; readonly draft_id: number }
  | { readonly kind: "missing_draft"; readonly draft_id: number };

type SourceTree = { name: string; root: string };
type PlanningSource = {
  id: number;
  name: string;
  local_path: string | null;
  last_synced_at: string | null;
  last_commit_sha: string | null;
};
type PlanningSourceStore = { listSources(): PlanningSource[] };

function sourceFiles(source: SourceTree): Map<string, string> {
  const files = new Map<string, string>();
  const pending = [source.root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".printpartner-source-snapshot.json") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        const path = relative(source.root, absolute).split(sep).join("/");
        files.set(path, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
      }
    }
  }
  return files;
}

function differenceFamily(path: string): string {
  const directory = dirname(path).split(sep).join("/");
  return directory === "." ? path.split("/")[0] ?? path : directory;
}

function differenceId(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

export function compareSourceTrees(input: {
  sourceA: SourceTree;
  sourceB: SourceTree;
}): BuildDifference[] {
  const filesA = sourceFiles(input.sourceA);
  const filesB = sourceFiles(input.sourceB);
  const differences: BuildDifference[] = [];
  const removed = new Map<string, string>();
  const added = new Map<string, string>();

  for (const [path, hashA] of filesA) {
    const hashB = filesB.get(path);
    if (hashB === undefined) removed.set(path, hashA);
    else if (hashA !== hashB) {
      differences.push({
        id: differenceId(["changed", input.sourceA.name, input.sourceB.name, path]),
        group_id: differenceFamily(path),
        family: differenceFamily(path),
        kind: "changed",
        source_a: input.sourceA.name,
        source_b: input.sourceB.name,
        path_a: path,
        path_b: path,
        detail: `Content differs at ${path}`,
      });
    }
  }
  for (const [path, hashB] of filesB) {
    if (!filesA.has(path)) added.set(path, hashB);
  }

  for (const [pathA, hashA] of [...removed]) {
    const renamed = [...added].find(([, hashB]) => hashA === hashB);
    if (!renamed) continue;
    const [pathB] = renamed;
    removed.delete(pathA);
    added.delete(pathB);
    const family = differenceFamily(pathA);
    differences.push({
      id: differenceId(["renamed", input.sourceA.name, input.sourceB.name, pathA, pathB]),
      group_id: family,
      family,
      kind: "renamed",
      source_a: input.sourceA.name,
      source_b: input.sourceB.name,
      path_a: pathA,
      path_b: pathB,
      detail: `${pathA} was renamed to ${pathB}`,
    });
  }
  for (const path of removed.keys()) {
    const family = differenceFamily(path);
    differences.push({ id: differenceId(["removed", input.sourceA.name, input.sourceB.name, path]), group_id: family, family, kind: "removed", source_a: input.sourceA.name, source_b: input.sourceB.name, path_a: path, detail: `${path} is absent from ${input.sourceB.name}` });
  }
  for (const path of added.keys()) {
    const family = differenceFamily(path);
    differences.push({ id: differenceId(["added", input.sourceA.name, input.sourceB.name, path]), group_id: family, family, kind: "added", source_a: input.sourceA.name, source_b: input.sourceB.name, path_b: path, detail: `${path} exists only in ${input.sourceB.name}` });
  }
  return differences.sort((left, right) => left.group_id.localeCompare(right.group_id) || left.id.localeCompare(right.id));
}

export function resolvedSourcePathExclusions(input: {
  brief: BuildPlanningBrief;
  sourceIdsByName: ReadonlyMap<string, number>;
}): { exclusions: Array<{ sourceId: number; path: string }>; blockers: string[] } {
  const excluded = new Map<string, { sourceId: number; path: string }>();
  const blockers: string[] = [];
  const groups = new Map<string, BuildDifference[]>();
  for (const difference of input.brief.differences) {
    const values = groups.get(difference.group_id) ?? [];
    values.push(difference);
    groups.set(difference.group_id, values);
  }
  const exclude = (sourceName: string, path: string | undefined, groupId: string): void => {
    if (!path || !path.toLowerCase().endsWith(".stl")) return;
    const sourceId = input.sourceIdsByName.get(sourceName);
    if (sourceId == null) {
      blockers.push(`${groupId}: resolved printable path is missing from the draft: ${sourceName}/${path}`);
      return;
    }
    excluded.set(`${sourceId}\0${path}`, { sourceId, path });
  };
  for (const [groupId, differences] of groups) {
    const resolution = input.brief.resolutions[groupId]?.resolution;
    if (!resolution || resolution === "include_both") continue;
    if (resolution === "custom") {
      blockers.push(`${groupId}: custom resolution requires explicit draft review`);
      continue;
    }
    for (const difference of differences) {
      if (resolution === "choose_source_a" || resolution === "not_applicable") {
        exclude(difference.source_b, difference.path_b, groupId);
      }
      if (resolution === "choose_source_b" || resolution === "not_applicable") {
        exclude(difference.source_a, difference.path_a, groupId);
      }
    }
  }
  return {
    exclusions: [...excluded.values()].sort((left, right) => left.sourceId - right.sourceId || left.path.localeCompare(right.path)),
    blockers,
  };
}

export function hydrateBuildPlanningBrief(
  sourceStore: PlanningSourceStore,
  brief: BuildPlanningBrief,
): BuildPlanningBrief {
  const sources = new Map(sourceStore.listSources().map((source) => [source.id, source]));
  const evidence = brief.evidence.map((item) => {
    const source = item.source_id == null ? undefined : sources.get(item.source_id);
    if (!source) return item;
    const synced = Boolean(source.local_path && source.last_synced_at && source.last_commit_sha);
    return {
      ...item,
      sync_status: synced ? "synced" as const : "pending" as const,
      pinned_revision: synced ? source.last_commit_sha ?? undefined : undefined,
    };
  });
  const structural = evidence.find((item) => item.source_role === "structural_base");
  const overlays = evidence.filter((item) => item.source_role === "overlay");
  let differences = brief.differences.filter((difference) => difference.kind !== "contradictory");
  if (structural?.sync_status === "synced") {
    const sourceA = structural.source_id == null ? undefined : sources.get(structural.source_id);
    if (sourceA?.local_path) {
      const sourceARoot = sourceA.local_path;
      differences = overlays.flatMap((overlay) => {
        const sourceB = overlay.source_id == null ? undefined : sources.get(overlay.source_id);
        if (overlay.sync_status !== "synced" || !sourceB?.local_path) return [];
        return compareSourceTrees({
          sourceA: { name: sourceA.name, root: sourceARoot },
          sourceB: { name: sourceB.name, root: sourceB.local_path },
        }).map((difference) => ({
          ...difference,
          group_id: `${structural.id}:${overlay.id}:${difference.group_id}`,
        }));
      });
    } else {
      differences = [];
    }
  }
  const claimsBySubject = new Map<string, BuildEvidence[]>();
  for (const item of evidence) {
    const subject = item.title?.trim().toLowerCase();
    if (!subject || !item.extract?.trim()) continue;
    const claims = claimsBySubject.get(subject) ?? [];
    claims.push(item);
    claimsBySubject.set(subject, claims);
  }
  for (const [subject, claims] of claimsBySubject) {
    for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
        const left = claims[leftIndex]!;
        const right = claims[rightIndex]!;
        if (left.extract!.trim() === right.extract!.trim()) continue;
        const groupId = `claims:${createHash("sha256").update(subject).digest("hex").slice(0, 12)}`;
        differences.push({
          id: differenceId(["contradictory", left.id, right.id, subject]),
          group_id: groupId,
          family: "documentation_claims",
          kind: "contradictory",
          source_a: left.url,
          source_b: right.url,
          detail: `Conflicting claims about ${left.title ?? subject}: ${left.extract!.trim().slice(0, 160)} <> ${right.extract!.trim().slice(0, 160)}`,
        });
      }
    }
  }
  const currentIds = new Set(differences.map((difference) => difference.group_id));
  return {
    ...brief,
    evidence,
    differences,
    resolutions: Object.fromEntries(
      Object.entries(brief.resolutions).filter(([groupId]) => currentIds.has(groupId)),
    ),
  };
}

function settingKey(buildId: number): string {
  return `${SETTING_PREFIX}${buildId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBuildRequirement(value: unknown): value is BuildRequirement {
  if (!isRecord(value)) return false;
  return typeof value.key === "string" && typeof value.value === "string" &&
    ["unverified", "satisfied", "incompatible", "user_waived"].includes(String(value.status)) &&
    (value.detail === undefined || typeof value.detail === "string");
}

function isBuildEvidence(value: unknown): value is BuildEvidence {
  if (!isRecord(value)) return false;
  const validKind = ["canonical_design", "vendor_overlay", "mod", "component", "model_source", "informational_evidence"].includes(String(value.kind));
  const validRole = value.source_role === undefined || ["structural_base", "overlay", "addon", "evidence"].includes(String(value.source_role));
  const optionalStrings = ["derived_from_evidence_id", "title", "extract", "retrieved_at", "content_hash", "pinned_revision"];
  const validArtifacts = value.artifacts === undefined ||
    (Array.isArray(value.artifacts) && value.artifacts.every((artifact) =>
      isRecord(artifact) && typeof artifact.path === "string" &&
      ["stl", "3mf", "zip"].includes(String(artifact.format)) &&
      typeof artifact.printable === "boolean" && Number.isSafeInteger(artifact.byte_size) &&
      typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256),
    ));
  return typeof value.id === "string" && value.id.length > 0 && typeof value.url === "string" &&
    typeof value.normalized_url === "string" && validKind && validRole &&
    (value.input_kind === undefined || ["url", "model_page", "upload"].includes(String(value.input_kind))) &&
    (value.source_id === undefined || (Number.isSafeInteger(value.source_id) && Number(value.source_id) > 0)) &&
    (value.filenames === undefined || isStringArray(value.filenames)) &&
    (value.upload_required === undefined || typeof value.upload_required === "boolean") &&
    optionalStrings.every((key) => value[key] === undefined || typeof value[key] === "string") &&
    validArtifacts &&
    (value.sync_status === undefined || ["pending", "synced", "failed"].includes(String(value.sync_status)));
}

function isSourceContribution(value: unknown): value is SourceContribution {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.evidence_id === "string" &&
    typeof value.slot === "string" && isStringArray(value.path_scopes) &&
    ["printable_parts", "hardware_constraint", "informational_evidence"].includes(String(value.responsibility)) &&
    ["low", "medium", "high"].includes(String(value.confidence)) &&
    ["proposed", "confirmed", "rejected"].includes(String(value.status)) &&
    typeof value.evidence_text === "string";
}

function isCompatibilityFinding(value: unknown): value is CompatibilityFinding {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.subject === "string" &&
    typeof value.detail === "string" && isStringArray(value.evidence_ids) &&
    ["unverified", "satisfied", "incompatible", "user_waived"].includes(String(value.status));
}

function isChecklistItem(value: unknown): value is BuildChecklistItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.title === "string" &&
    ["test_fit", "wiring", "safety", "pre_print", "other"].includes(String(value.category)) &&
    typeof value.required === "boolean" && typeof value.completed === "boolean" &&
    (value.detail === undefined || typeof value.detail === "string");
}

function isBuildDifference(value: unknown): value is BuildDifference {
  if (!isRecord(value)) return false;
  return ["id", "group_id", "family", "source_a", "source_b", "detail"].every((key) => typeof value[key] === "string") &&
    ["added", "removed", "changed", "renamed", "contradictory"].includes(String(value.kind)) &&
    (value.path_a === undefined || typeof value.path_a === "string") &&
    (value.path_b === undefined || typeof value.path_b === "string");
}

function isResolution(value: unknown): value is DifferenceGroupResolution {
  if (!isRecord(value)) return false;
  return ["choose_source_a", "choose_source_b", "include_both", "not_applicable", "custom"].includes(String(value.resolution)) &&
    typeof value.rationale === "string" && typeof value.resolved_at === "string" &&
    (value.custom_resolution === undefined || typeof value.custom_resolution === "string");
}

function isFilamentAssignment(value: unknown): value is RoleFilamentAssignment {
  if (!isRecord(value)) return false;
  return typeof value.role === "string" && ["catalog", "spoolman", "custom", "substitute"].includes(String(value.inventory_kind)) &&
    typeof value.color_hex === "string" && /^#[a-f0-9]{6}$/i.test(value.color_hex) &&
    typeof value.substitution_confirmed === "boolean" &&
    ["inventory_id", "requested_brand", "requested_name"].every((key) => value[key] === undefined || typeof value[key] === "string");
}

function isBuildPlanningBrief(value: unknown): value is BuildPlanningBrief {
  if (!isRecord(value) || value.version !== BUILD_PLANNING_VERSION) return false;
  return Number.isSafeInteger(value.build_id) && Number(value.build_id) > 0 && typeof value.special_request === "string" &&
    Array.isArray(value.requirements) && value.requirements.every(isBuildRequirement) &&
    Array.isArray(value.evidence) && value.evidence.every(isBuildEvidence) &&
    Array.isArray(value.contributions) && value.contributions.every(isSourceContribution) &&
    (value.compatibility_findings === undefined ||
      (Array.isArray(value.compatibility_findings) && value.compatibility_findings.every(isCompatibilityFinding))) &&
    Array.isArray(value.differences) && value.differences.every(isBuildDifference) &&
    isRecord(value.resolutions) && Object.values(value.resolutions).every(isResolution) &&
    Array.isArray(value.role_filaments) && value.role_filaments.every(isFilamentAssignment) &&
    (value.checklist_items === undefined || (Array.isArray(value.checklist_items) && value.checklist_items.every(isChecklistItem))) &&
    (value.managed_source_ids === undefined ||
      (Array.isArray(value.managed_source_ids) && value.managed_source_ids.every((id) => Number.isSafeInteger(id)))) &&
    (value.draft_source_revisions === undefined ||
      (isRecord(value.draft_source_revisions) && Object.values(value.draft_source_revisions).every((revision) => typeof revision === "string"))) &&
    isStringArray(value.draft_review_blockers) && typeof value.created_at === "string" && !Number.isNaN(Date.parse(value.created_at)) &&
    typeof value.updated_at === "string" && !Number.isNaN(Date.parse(value.updated_at)) &&
    (value.draft_id === undefined || (Number.isSafeInteger(value.draft_id) && Number(value.draft_id) > 0));
}

export function parseBuildPlanningBrief(raw: string): BuildPlanningBrief {
  const parsed: unknown = JSON.parse(raw);
  if (isRecord(parsed) && parsed.version !== BUILD_PLANNING_VERSION) {
    throw new Error("Unsupported Build planning brief version");
  }
  if (!isBuildPlanningBrief(parsed)) throw new Error("Invalid Build planning brief data");
  return parsed;
}

export function normalizedUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only public HTTP(S) URLs are supported");
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

export function classifyBuildUrl(raw: string): BuildEvidence {
  const url = normalizedUrl(raw);
  const parsed = new URL(url);
  const path = parsed.pathname.toLowerCase();
  const host = parsed.hostname;
  let kind: EvidenceKind = "informational_evidence";
  let sourceRole: BuildEvidence["source_role"];
  if (host === "github.com" || path.endsWith(".git")) {
    kind = "mod";
    sourceRole = "addon";
  }
  const modelLibraryHosts = [
    "printables.com",
    "makerworld.com",
    "thingiverse.com",
    "thangs.com",
    "cults3d.com",
    "myminifactory.com",
  ];
  const isModelPage = modelLibraryHosts.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  if (isModelPage)
    kind = "model_source";
  return {
    id: createHash("sha256").update(url).digest("hex").slice(0, 20),
    url: raw,
    normalized_url: url,
    kind,
    input_kind: isModelPage ? "model_page" : "url",
    upload_required: isModelPage || undefined,
    source_role: sourceRole,
    sync_status: kind === "informational_evidence" || isModelPage ? undefined : "pending",
  };
}

export function buildEvidenceFromUploadedSource(input: {
  sourceId: number;
  sourceName: string;
  filenames?: string[];
  artifacts?: SourceArtifact[];
  derivedFromEvidenceId?: string;
}): BuildEvidence {
  if (!Number.isInteger(input.sourceId) || input.sourceId <= 0) {
    throw new Error("Uploaded Source id must be a positive integer");
  }
  const normalized = `printpartner:source:${input.sourceId}`;
  return {
    id: createHash("sha256").update(normalized).digest("hex").slice(0, 20),
    url: normalized,
    normalized_url: normalized,
    kind: "model_source",
    input_kind: "upload",
    source_id: input.sourceId,
    title: input.sourceName,
    filenames: [...new Set((input.artifacts?.map((artifact) => artifact.path) ?? input.filenames ?? []).map((name) => name.trim()).filter(Boolean))],
    artifacts: input.artifacts,
    derived_from_evidence_id: input.derivedFromEvidenceId,
    sync_status: "pending",
  };
}

function evidenceTerms(evidence: BuildEvidence): string[] {
  const parsed = new URL(evidence.normalized_url);
  return parsed.pathname
    .split(/[/_.-]+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !["github", "repository", "repo"].includes(term));
}

function classifyEvidenceFromRequest(
  request: string,
  evidence: BuildEvidence,
): BuildEvidence {
  const clauses = request.split(/\b(?:then|and)\b|[,.;]/i);
  const terms = evidenceTerms(evidence);
  const owner = new URL(evidence.normalized_url).pathname
    .split("/")
    .filter(Boolean)[0]
    ?.toLowerCase();
  const clause = clauses
    .map((candidate) => {
      const termMatches = terms.filter((term) =>
        candidate.toLowerCase().includes(term),
      ).length;
      const roleBonus = /\b(?:canonical|official|structural|base|vendor|overlay|mod|addon|add-on)\b/i.test(
        candidate,
      )
        ? 1
        : 0;
      const ownerBonus = owner && candidate.toLowerCase().includes(owner) ? 100 : 0;
      return {
        text: candidate,
        termMatches,
        score: ownerBonus + termMatches * 10 + roleBonus,
      };
    })
    .sort((left, right) => right.score - left.score)[0];
  if (!clause || clause.termMatches === 0) return evidence;
  const text = clause.text.toLowerCase();
  if (/\bvendor(?:-kit)?\b.*\boverlay\b|\bvendor-kit overlay\b/.test(text)) {
    return { ...evidence, kind: "vendor_overlay", source_role: "overlay" };
  }
  if (
    /\bcanonical\b|\bstructural\s+base\b|\bofficial\b.*\b(?:base|design)\b/.test(
      text,
    )
  ) {
    return {
      ...evidence,
      kind: "canonical_design",
      source_role: "structural_base",
    };
  }
  if (/\b(?:mod|addon|add-on)\b/.test(text)) {
    return { ...evidence, kind: "mod", source_role: "addon" };
  }
  return evidence;
}

/**
 * Requirements read off a build request by *shape*, not by product name.
 *
 * Naming specific machines, toolheads or boards here would bias every request
 * toward one ecosystem; the slot vocabulary comes from the kit catalog instead,
 * and anything unrecognised is still captured as a requested feature below.
 */
const REQUIREMENT_PATTERNS: Array<[string, RegExp]> = [
  // "2.4r2" attaches the revision straight onto the version, so allow both.
  ["revision", /\d(r\d+)\b|\b(r\d+|v\d+(?:\.\d+)+|rev\s*\d+)\b/i],
  ["size", /\b(\d{3})\s*mm\b/i],
  ["transport", /\b(usb|can(?:bus)?|ethernet|wifi)\b/i],
  ["umbilical", /\b(usb|can(?:bus)?)\s+umbilical\b/i],
];

/** Catalog slot ids the request names directly ("… for the probe slot"). */
function slotRequirementsFromRequest(request: string, knownSlots: readonly string[]): BuildRequirement[] {
  const found: BuildRequirement[] = [];
  for (const slot of knownSlots) {
    const label = slot.replace(/[_-]+/g, "[ _-]?");
    // Stop at a conjunction or punctuation so "probe X and toolhead Y" splits.
    const m = new RegExp(
      `\\b${label}\\b\\s*[:=]?\\s*([\\w][\\w .+-]{0,40}?)(?=\\s+and\\s|\\s*[,;]|\\.(?!\\d)|$)`,
      "i",
    ).exec(request);
    const value = m?.[1]?.trim().replace(/[.,;]+$/, "");
    if (value) found.push({ key: slot, value, status: "unverified" });
  }
  return found;
}

export function analyzeBuildRequest(
  request: string,
  urls: string[],
  knownSlots: readonly string[] = [],
) {
  const requirements: BuildRequirement[] = [];
  for (const [key, pattern] of REQUIREMENT_PATTERNS) {
    const match = request.match(pattern);
    const value = match?.[1] ?? match?.[2];
    if (value)
      requirements.push({ key, value: value.trim(), status: "unverified" });
  }
  requirements.push(...slotRequirementsFromRequest(request, knownSlots));
  const colorMatches = request.matchAll(
    /\b(primary|accent)\s+color\s+(?:is|[:=])\s*(.+?)(?=\s+and\s+(?:primary|accent)\s+color|[,.;]|$)/gi,
  );
  for (const match of colorMatches) {
    const role = match[1]?.toLowerCase();
    const color = match[2]?.trim();
    if (!role || !color) continue;
    requirements.push({
      key: `color_${role}`,
      value: color,
      status: "unverified",
    });
  }
  // What the user said they are building, in their own words — the only
  // project identifier available without a built-in machine list.
  const project = /\b(?:build|print|make)\s+(?:(?:a|an|the)\s+)?(.+?)(?=\s+with\b|\s+using\b|\s+from\b|[,;]|\.(?!\d)|$)/i.exec(request)?.[1]?.trim();
  if (project && !/^(?:this|that|these|those)\b/i.test(project)) {
    requirements.unshift({ key: "project", value: project, status: "unverified" });
  }
  const featureMatches = request.matchAll(/\b(?:with|include|including|needs?|must have)\s+(.+?)(?=\s+(?:with|include|including|needs?|must have)\b|[,.;]|$)/gi);
  let featureIndex = 0;
  for (const match of featureMatches) {
    const value = match[1]?.trim();
    if (!value) continue;
    featureIndex += 1;
    requirements.push({ key: `requested_feature_${featureIndex}`, value, status: "unverified" });
  }
  return {
    special_request: request,
    requirements,
    evidence: urls
      .map(classifyBuildUrl)
      .map((evidence) => classifyEvidenceFromRequest(request, evidence)),
  };
}

export function readBuildPlanningBrief(
  repo: AppRepository,
  buildId: number,
): BuildPlanningBrief | null {
  const raw = repo.getSetting(settingKey(buildId));
  if (!raw) return null;
  const brief = parseBuildPlanningBrief(raw);
  if (brief.build_id !== buildId) throw new Error("Build planning brief belongs to another Build");
  return brief;
}

export function saveBuildPlanningBrief(
  repo: AppRepository,
  brief: BuildPlanningBrief,
): void {
  repo.setSetting(
    settingKey(brief.build_id),
    JSON.stringify({ ...brief, updated_at: new Date().toISOString() }),
  );
}

export function deriveBuildPlanningReadiness(
  brief: BuildPlanningBrief,
): BuildPlanningReadiness {
  const blockers: BuildPlanningReadiness["blockers"] = [];
  const sourceEvidence = brief.evidence.filter(
    (evidence) => evidence.source_id != null && evidence.kind !== "informational_evidence",
  );
  const structuralCount = sourceEvidence.filter((evidence) => evidence.source_role === "structural_base").length;
  if (sourceEvidence.some((evidence) => evidence.source_role == null)) {
    blockers.push({ code: "source_role", detail: "Every printable Source needs a confirmed Build role" });
  }
  if (sourceEvidence.length > 0 && structuralCount !== 1) {
    blockers.push({ code: "source_roles", detail: "Build planning requires exactly one structural base Source" });
  }
  for (const evidence of brief.evidence) {
    if (
      evidence.input_kind === "model_page" &&
      evidence.upload_required &&
      !brief.evidence.some(
        (candidate) =>
          candidate.input_kind === "upload" &&
          candidate.derived_from_evidence_id === evidence.id,
      )
    ) {
      blockers.push({
        code: "model_files_missing",
        detail: `${evidence.normalized_url} needs an attached file upload`,
      });
    }
    if (
      evidence.sync_status === "pending" ||
      evidence.sync_status === "failed"
    ) {
      blockers.push({
        code: "source_sync",
        detail: `${evidence.normalized_url}: ${evidence.sync_status}`,
      });
    }
    if (evidence.sync_status === "synced" && !evidence.pinned_revision) {
      blockers.push({
        code: "source_provenance",
        detail: `${evidence.normalized_url} has no pinned revision`,
      });
    }
    if (
      brief.draft_id != null &&
      evidence.source_id != null &&
      evidence.source_role !== "evidence" &&
      evidence.pinned_revision &&
      brief.draft_source_revisions?.[String(evidence.source_id)] !== evidence.pinned_revision
    ) {
      blockers.push({
        code: "draft_source_changed",
        detail: `${evidence.normalized_url} changed after draft ${brief.draft_id} was built`,
      });
    }
  }
  for (const requirement of brief.requirements) {
    if (
      requirement.status === "unverified" ||
      requirement.status === "incompatible"
    ) {
      blockers.push({
        code: `requirement_${requirement.status}`,
        detail: `${requirement.key}: ${requirement.value}`,
      });
    }
  }
  for (const contribution of brief.contributions ?? []) {
    if (contribution.status === "proposed") {
      blockers.push({
        code: "unconfirmed_contribution",
        detail: `${contribution.slot}: ${contribution.id}`,
      });
    }
  }
  for (const finding of brief.compatibility_findings ?? []) {
    if (finding.status === "unverified" || finding.status === "incompatible") {
      blockers.push({
        code: `compatibility_${finding.status}`,
        detail: `${finding.subject}: ${finding.detail}`,
      });
    }
  }
  const groups = new Set(
    brief.differences.map((difference) => difference.group_id),
  );
  for (const groupId of groups) {
    if (!brief.resolutions[groupId])
      blockers.push({ code: "open_difference", detail: groupId });
  }
  for (const assignment of brief.role_filaments) {
    if (
      assignment.inventory_kind === "substitute" &&
      !assignment.substitution_confirmed
    ) {
      blockers.push({
        code: "unconfirmed_filament_substitute",
        detail: assignment.role,
      });
    }
  }
  for (const item of brief.checklist_items ?? []) {
    if (item.required && !item.completed) {
      blockers.push({ code: "checklist_incomplete", detail: item.title });
    }
  }
  for (const detail of brief.draft_review_blockers)
    blockers.push({ code: "draft_review", detail });
  if (brief.draft_id == null)
    blockers.push({
      code: "draft_missing",
      detail: "Rebuild and review a plan draft",
    });
  return { ready: blockers.length === 0, blockers };
}

export function deriveBuildPlanningPhase(
  repo: Pick<AppRepository, "getPlanDraft">,
  brief: BuildPlanningBrief,
): BuildPlanningPhase {
  if (brief.draft_id == null) return { kind: "preparing" };
  const draft = repo.getPlanDraft(brief.build_id, brief.draft_id);
  if (!draft) return { kind: "missing_draft", draft_id: brief.draft_id };
  switch (draft.state) {
    case "open":
      return { kind: "draft", draft_id: draft.id };
    case "consumed":
      return {
        kind: "applied",
        draft_id: draft.id,
        revision_id: draft.consumedRevisionId ?? null,
      };
    case "abandoned":
      return { kind: "abandoned", draft_id: draft.id };
    default: {
      const exhaustive: never = draft.state;
      return exhaustive;
    }
  }
}

export function newBuildPlanningBrief(
  buildId: number,
  request: string,
  urls: string[],
  knownSlots: readonly string[] = [],
): BuildPlanningBrief {
  const analyzed = analyzeBuildRequest(request, urls, knownSlots);
  const now = new Date().toISOString();
  return {
    version: BUILD_PLANNING_VERSION,
    build_id: buildId,
    special_request: request,
    requirements: analyzed.requirements,
    evidence: analyzed.evidence,
    contributions: [],
    compatibility_findings: [],
    differences: [],
    resolutions: {},
    role_filaments: [],
    checklist_items: [],
    managed_source_ids: [],
    draft_source_revisions: {},
    draft_review_blockers: [],
    created_at: now,
    updated_at: now,
  };
}
