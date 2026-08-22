import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import type { AppRepository } from "../db/repository.js";
import {
  formatCompatibilityDigestLine,
  normalizeCompatibility,
} from "./compatibility.js";

const MODULE_DATA = join(dirname(fileURLToPath(import.meta.url)), "../data/assistant-domain");
const SRC_DATA = join(dirname(fileURLToPath(import.meta.url)), "../../src/data/assistant-domain");

export const MAX_DOMAIN_PACK_CHARS = 5200;

/** Stable titles for curated research notes upserted into source_notes. */
export const ADVISOR_NOTE_TITLES = {
  workflow: "Advisor: Workflow",
  pitfalls: "Advisor: Pitfalls",
  quotes: "Advisor: Quotes",
} as const;

const MAX_WORKFLOW_EXCERPT = 120;
const MAX_PITFALLS_EXCERPT = 100;
const MAX_SOURCES_WITH_MD_EXCERPTS = 5;

export type AliasResolve = {
  catalog_base_id?: string | null;
  source_name?: string | null;
  tag?: string | null;
  branch?: string | null;
  addons?: string[];
  notes?: string | null;
  selection?: Record<string, string>;
};

export type SourceIdentity = {
  source_name?: string;
  role?: string;
  summary?: string;
  important_tags?: Array<{ id?: string }>;
};

export type SourceDecisionYaml = {
  id: string;
  kind?: string;
  label?: string;
  options?: Array<{ id: string; label?: string; selection?: Record<string, string> }>;
};

export type AliasEntry = {
  phrases: string[];
  resolve: AliasResolve;
};

export type StackEntry = {
  label?: string;
  base_source?: string;
  base_tag?: string | null;
  catalog_base_id?: string | null;
  addon_sources?: string[];
  default_selections?: Record<string, string>;
  notes?: string;
};

export type DomainImportPayload = {
  global?: {
    alias_map?: unknown;
    stacks?: unknown;
    merge_conflicts?: unknown;
    pitfalls_md?: string;
  };
  sources?: Array<{
    source_name: string;
    identity?: unknown;
    compatibility?: unknown;
    workflow_md?: string;
    pitfalls_md?: string;
    quotes_md?: string;
    notes?: Array<{ title: string; body_markdown: string }>;
  }>;
  /** When true, write under dataDir/assistant-domain (default true). */
  write_files?: boolean;
  /** When true (default if repo provided), upsert Advisor notes from on-disk workflow/pitfalls/quotes. */
  backfill_notes?: boolean;
};

function candidateRoots(dataDir?: string | null): string[] {
  const roots: string[] = [];
  if (dataDir) roots.push(join(dataDir, "assistant-domain"));
  roots.push(MODULE_DATA, SRC_DATA);
  return roots;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function loadYamlFile(path: string): unknown | null {
  const text = readText(path);
  if (text == null) return null;
  try {
    return yaml.load(text);
  } catch {
    return null;
  }
}

function firstExisting(...paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function findFile(dataDir: string | null | undefined, ...rel: string[]): string | null {
  for (const root of candidateRoots(dataDir)) {
    const p = join(root, ...rel);
    if (existsSync(p)) return p;
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n…[truncated]`;
}

function compactExcerpt(text: string | null | undefined, max: number): string {
  if (!text?.trim()) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Upsert a global (profile-less) source note by stable title.
 * Returns true when a note was created or updated.
 */
export function upsertAdvisorSourceNote(
  repo: AppRepository,
  projectId: number,
  title: string,
  bodyMarkdown: string,
): boolean {
  const body = bodyMarkdown.trim();
  if (!body) return false;
  const existing = repo
    .listSourceNotes(projectId)
    .find((n) => n.title === title && n.profile_id == null);
  if (existing) {
    if (existing.body_markdown.trim() === body) return false;
    repo.updateSourceNote(existing.id, { title, bodyMarkdown: body });
  } else {
    repo.createSourceNote({ projectId, title, bodyMarkdown: body });
  }
  return true;
}

/** Upsert Advisor: Workflow / Pitfalls / Quotes from markdown bodies. */
export function upsertAdvisorNotesFromMarkdown(
  repo: AppRepository,
  projectId: number,
  files: { workflow?: string | null; pitfalls?: string | null; quotes?: string | null },
): number {
  let count = 0;
  if (upsertAdvisorSourceNote(repo, projectId, ADVISOR_NOTE_TITLES.workflow, files.workflow ?? "")) {
    count += 1;
  }
  if (upsertAdvisorSourceNote(repo, projectId, ADVISOR_NOTE_TITLES.pitfalls, files.pitfalls ?? "")) {
    count += 1;
  }
  if (upsertAdvisorSourceNote(repo, projectId, ADVISOR_NOTE_TITLES.quotes, files.quotes ?? "")) {
    count += 1;
  }
  return count;
}

function upsertAdvisorNotesFromSourceDir(
  repo: AppRepository,
  projectId: number,
  sourceDir: string,
): number {
  return upsertAdvisorNotesFromMarkdown(repo, projectId, {
    workflow: readText(join(sourceDir, "workflow.md")),
    pitfalls: readText(join(sourceDir, "pitfalls.md")),
    quotes: readText(join(sourceDir, "quotes.md")),
  });
}

/**
 * One-shot / on-import backfill: for each on-disk domain source whose name matches a
 * live Print Partner source, upsert source_notes from workflow.md / pitfalls.md / quotes.md.
 */
export function backfillAdvisorNotesFromDomainPack(
  repo: AppRepository,
  dataDir?: string | null,
): { notes_upserted: number; sources_matched: number } {
  let notesUpserted = 0;
  let sourcesMatched = 0;
  const seen = new Set<string>();
  const liveByName = new Map(repo.listSources().map((s) => [s.name, s]));

  for (const root of candidateRoots(dataDir)) {
    const sourcesRoot = join(root, "sources");
    if (!existsSync(sourcesRoot)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(sourcesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of dirs) {
      if (seen.has(name)) continue;
      seen.add(name);
      const match = liveByName.get(name);
      if (!match) continue;
      sourcesMatched += 1;
      notesUpserted += upsertAdvisorNotesFromSourceDir(repo, match.id, join(sourcesRoot, name));
    }
  }
  return { notes_upserted: notesUpserted, sources_matched: sourcesMatched };
}

const KNOWN_BRANCH_REFS = new Set([
  "main",
  "master",
  "develop",
  "Voron2.4",
  "Voron0.2r1",
  "v02r1",
  "s1",
]);

function splitAddonNames(addons: unknown): string[] {
  if (!Array.isArray(addons)) return [];
  return addons
    .map((a) => {
      if (typeof a === "string") return a.split("@")[0] ?? a;
      if (a && typeof a === "object" && "source_name" in a) {
        return String((a as { source_name?: string }).source_name ?? "");
      }
      return "";
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

function refToTagOrBranch(ref: unknown): { tag?: string | null; branch?: string | null } {
  if (ref == null || ref === "") return {};
  const value = String(ref);
  if (KNOWN_BRANCH_REFS.has(value)) return { branch: value, tag: null };
  return { tag: value, branch: null };
}

function normalizeSelectionMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null || v === "") continue;
    out[k] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Accept both schema docs (phrases/resolve) and research-output (phrase/ref) shapes. */
export function normalizeAliasEntry(raw: unknown): AliasEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.phrases) || o.resolve) {
    const resolveRaw = (o.resolve ?? {}) as AliasResolve;
    const phrases = Array.isArray(o.phrases)
      ? o.phrases.map(String).filter(Boolean)
      : typeof o.phrase === "string"
        ? [o.phrase]
        : [];
    if (!phrases.length && !resolveRaw.source_name) return null;
    const selection =
      normalizeSelectionMap(resolveRaw.selection) ?? normalizeSelectionMap(o.selection);
    return {
      phrases,
      resolve: {
        ...resolveRaw,
        ...(selection ? { selection } : {}),
      },
    };
  }
  const phraseField = typeof o.phrase === "string" ? o.phrase : "";
  const phrases = phraseField
    .split(/\s*\/\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!phrases.length && !o.source_name) return null;
  const { tag, branch } = refToTagOrBranch(o.ref);
  const selection = normalizeSelectionMap(o.selection);
  return {
    phrases,
    resolve: {
      source_name: o.source_name != null ? String(o.source_name) : null,
      tag: tag ?? null,
      branch: branch ?? null,
      catalog_base_id: o.catalog_base_id != null ? String(o.catalog_base_id) : null,
      addons: splitAddonNames(o.addons),
      notes: o.note != null ? String(o.note) : o.notes != null ? String(o.notes) : null,
      ...(selection ? { selection } : {}),
    },
  };
}

/** Load phrase aliases from domain pack alias_map.yaml. */
export function loadAliasEntries(dataDir?: string | null): AliasEntry[] {
  const aliasPath = findFile(dataDir, "_global", "alias_map.yaml");
  if (!aliasPath) return [];
  const raw = loadYamlFile(aliasPath) as { aliases?: unknown[] } | null;
  return (raw?.aliases ?? [])
    .map(normalizeAliasEntry)
    .filter((a): a is AliasEntry => a != null);
}

/**
 * Find identity.yaml for a source_name. Dir names may be sanitized
 * (e.g. `DW-Tas-emu` for `DW-Tas/emu`); also matches identity.source_name.
 */
export function findIdentityForSource(
  sourceName: string,
  dataDir?: string | null,
): SourceIdentity | null {
  const name = sourceName.trim();
  if (!name) return null;
  const sanitized = name.replace(/\//g, "-");
  for (const root of candidateRoots(dataDir)) {
    const sourcesRoot = join(root, "sources");
    if (!existsSync(sourcesRoot)) continue;
    const direct = [name, sanitized]
      .map((d) => join(sourcesRoot, d, "identity.yaml"))
      .find((p) => existsSync(p));
    if (direct) {
      const id = loadYamlFile(direct) as SourceIdentity | null;
      if (id) return id;
    }
    let dirs: string[];
    try {
      dirs = readdirSync(sourcesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const identity = loadYamlFile(join(sourcesRoot, dir, "identity.yaml")) as SourceIdentity | null;
      if (!identity) continue;
      if (
        identity.source_name === name ||
        dir === name ||
        dir === sanitized ||
        dir.replace(/-/g, "/") === name
      ) {
        return identity;
      }
    }
  }
  return null;
}

/** Load optional per-source decisions.yaml candidates from the domain pack. */
export function loadSourceDecisionsYaml(
  sourceName: string,
  dataDir?: string | null,
): SourceDecisionYaml[] {
  const name = sourceName.trim();
  if (!name) return [];
  const sanitized = name.replace(/\//g, "-");
  for (const root of candidateRoots(dataDir)) {
    const sourcesRoot = join(root, "sources");
    if (!existsSync(sourcesRoot)) continue;
    const candidates = [name, sanitized];
    let dirs: string[] = [];
    try {
      dirs = readdirSync(sourcesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      /* ignore */
    }
    for (const dir of [...candidates, ...dirs]) {
      const decisionsPath = join(sourcesRoot, dir, "decisions.yaml");
      if (!existsSync(decisionsPath)) continue;
      if (!candidates.includes(dir)) {
        const identity = loadYamlFile(join(sourcesRoot, dir, "identity.yaml")) as SourceIdentity | null;
        if (
          identity?.source_name !== name &&
          dir !== name &&
          dir !== sanitized &&
          dir.replace(/-/g, "/") !== name
        ) {
          continue;
        }
      }
      const raw = loadYamlFile(decisionsPath) as { decisions?: unknown[] } | null;
      const list = Array.isArray(raw?.decisions) ? raw!.decisions! : [];
      const out: SourceDecisionYaml[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id.trim() : "";
        if (!id) continue;
        const optionsRaw = Array.isArray(row.options) ? row.options : [];
        const options: SourceDecisionYaml["options"] = [];
        for (const opt of optionsRaw) {
          if (!opt || typeof opt !== "object") continue;
          const o = opt as Record<string, unknown>;
          const oid = typeof o.id === "string" ? o.id.trim() : "";
          if (!oid) continue;
          options.push({
            id: oid,
            label: typeof o.label === "string" ? o.label : undefined,
            selection: normalizeSelectionMap(o.selection),
          });
        }
        out.push({
          id,
          kind: typeof row.kind === "string" ? row.kind : undefined,
          label: typeof row.label === "string" ? row.label : undefined,
          options,
        });
      }
      return out;
    }
  }
  return [];
}

/** Accept map form or research array form for stacks. */
export function normalizeStacks(raw: unknown): Array<{ id: string; stack: StackEntry }> {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out: Array<{ id: string; stack: StackEntry }> = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const base =
        o.base && typeof o.base === "object" ? (o.base as Record<string, unknown>) : {};
      const name = o.name != null ? String(o.name) : `stack_${i}`;
      const baseRef = base.ref ?? o.base_tag;
      const { tag } = refToTagOrBranch(baseRef);
      const branch = KNOWN_BRANCH_REFS.has(String(baseRef ?? "")) ? String(baseRef) : null;
      const stack: StackEntry = {
        label: name,
        base_source:
          base.source_name != null
            ? String(base.source_name)
            : o.base_source != null
              ? String(o.base_source)
              : undefined,
        base_tag: tag ?? branch ?? (baseRef != null ? String(baseRef) : null),
        catalog_base_id: o.catalog_base_id != null ? String(o.catalog_base_id) : null,
        addon_sources: splitAddonNames(o.addons ?? o.addon_sources),
        default_selections:
          o.default_selections && typeof o.default_selections === "object"
            ? Object.fromEntries(
                Object.entries(o.default_selections as Record<string, unknown>).map(
                  ([k, v]) => [k, String(v)],
                ),
              )
            : undefined,
        notes: o.notes != null ? String(o.notes) : undefined,
      };
      out.push({ id: name, stack });
    }
    return out;
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, StackEntry>).map(([id, stack]) => ({
      id,
      stack: stack ?? {},
    }));
  }
  return [];
}

export function normalizeConflict(raw: unknown): {
  slug_or_path: string;
  sources: string[];
  resolution: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const paths = Array.isArray(o.paths) ? o.paths.map(String) : [];
  const slug =
    (o.slug_or_path != null && String(o.slug_or_path)) ||
    (o.id != null && String(o.id)) ||
    paths[0] ||
    "?";
  const sources = Array.isArray(o.sources)
    ? o.sources.map(String)
    : Array.isArray(o.stacks)
      ? o.stacks.map(String)
      : [];
  return {
    slug_or_path: slug,
    sources,
    resolution: o.resolution != null ? String(o.resolution) : "",
  };
}

function formatAliasLines(aliases: AliasEntry[], noteMax = 72): string[] {
  const lines: string[] = ["### Phrase aliases → exact sources"];
  for (const a of aliases.slice(0, 48)) {
    const phrases = (a.phrases ?? []).slice(0, 4).join(" / ");
    const r = a.resolve ?? {};
    const bits = [
      r.source_name && `source=${r.source_name}`,
      r.tag && `tag=${r.tag}`,
      r.branch && `branch=${r.branch}`,
      r.catalog_base_id && `base_id=${r.catalog_base_id}`,
      (r.addons?.length ?? 0) > 0 && `addons=[${r.addons!.join(",")}]`,
    ].filter(Boolean);
    lines.push(`- "${phrases}" → ${bits.join(" ")}`);
    if (r.notes) lines.push(`  note: ${String(r.notes).replace(/\s+/g, " ").slice(0, noteMax)}`);
  }
  return lines;
}

function formatStacksSection(dataDir: string | null): string[] {
  const stacksPath = findFile(dataDir, "_global", "stacks.yaml");
  if (!stacksPath) return [];
  const raw = loadYamlFile(stacksPath) as { stacks?: unknown } | null;
  const entries = normalizeStacks(raw?.stacks ?? {}).slice(0, 12);
  if (!entries.length) return [];
  const lines = ["### Stack recipes"];
  for (const { id, stack: s } of entries) {
    lines.push(
      `- ${id}: base=${s.base_source ?? "?"}${s.base_tag ? `@${s.base_tag}` : ""}; addons=[${(s.addon_sources ?? []).join(", ")}]`,
    );
  }
  return lines;
}

function formatConflictsSection(dataDir: string | null): string[] {
  const conflictsPath = findFile(dataDir, "_global", "merge_conflicts.yaml");
  if (!conflictsPath) return [];
  const raw = loadYamlFile(conflictsPath) as { conflicts?: unknown[] } | null;
  const conflicts = (raw?.conflicts ?? [])
    .map(normalizeConflict)
    .filter((c): c is NonNullable<typeof c> => c != null);
  if (!conflicts.length) return [];
  const lines = ["### Known merge conflicts"];
  for (const c of conflicts.slice(0, 10)) {
    lines.push(`- ${c.slug_or_path}: ${c.resolution.slice(0, 120)}`);
  }
  return lines;
}

function formatSourceDigestsSection(dataDir: string | null): string[] {
  for (const root of candidateRoots(dataDir)) {
    const sourcesRoot = join(root, "sources");
    if (!existsSync(sourcesRoot)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(sourcesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      continue;
    }
    if (!dirs.length) continue;
    const lines = ["### Source digests"];
    let mdExcerptCount = 0;
    for (const name of dirs.slice(0, 14)) {
      const dir = join(sourcesRoot, name);
      const identity = loadYamlFile(join(dir, "identity.yaml")) as Record<
        string,
        unknown
      > | null;
      const compat = loadYamlFile(join(dir, "compatibility.yaml")) as Record<
        string,
        unknown
      > | null;
      const workflowText = readText(join(dir, "workflow.md"));
      const pitfallsText = readText(join(dir, "pitfalls.md"));
      if (!identity && !compat && !workflowText?.trim() && !pitfallsText?.trim()) continue;
      const summary = identity?.summary ? String(identity.summary) : "";
      const role = identity?.role ? String(identity.role) : "";
      const tags = Array.isArray(identity?.important_tags)
        ? (identity!.important_tags as Array<{ id?: string }>)
            .map((t) => t.id)
            .filter(Boolean)
            .slice(0, 4)
            .join(",")
        : "";
      lines.push(
        `- ${name}${role ? ` [${role}]` : ""}${tags ? ` tags=${tags}` : ""}${
          summary ? ` — ${summary.slice(0, 80)}` : ""
        }`,
      );
      const compatNorm = normalizeCompatibility(compat);
      if (compatNorm) {
        const compatLine = formatCompatibilityDigestLine(compatNorm);
        if (compatLine) lines.push(compatLine);
      }
      if (mdExcerptCount < MAX_SOURCES_WITH_MD_EXCERPTS) {
        const workflowExcerpt = compactExcerpt(workflowText, MAX_WORKFLOW_EXCERPT);
        const pitfallsExcerpt = compactExcerpt(pitfallsText, MAX_PITFALLS_EXCERPT);
        if (workflowExcerpt) {
          lines.push(`  workflow: ${workflowExcerpt}`);
          mdExcerptCount += 1;
        }
        if (pitfallsExcerpt) {
          lines.push(`  pitfalls: ${pitfallsExcerpt}`);
        }
      }
    }
    return lines;
  }
  return [];
}

function formatPackPitfallsSection(dataDir: string | null): string[] {
  const pitfallsPath = findFile(dataDir, "_global", "pitfalls.md");
  if (!pitfallsPath) return [];
  const text = readText(pitfallsPath);
  if (!text?.trim()) return [];
  return ["### Pack pitfalls", text.trim().slice(0, 800)];
}

/**
 * Pack under budget with priority: stacks/conflicts/digests (workflow+pitfalls)
 * first, then aliases fill remaining space (notes shortened to fit).
 * Always reserve room for aliases so phrase → source mappings stay visible.
 */
function joinUnderBudget(header: string, priority: string[][], aliases: string[], maxChars: number): string {
  if (!aliases.length) {
    return truncate([header, ...priority.flat()].join("\n"), maxChars);
  }

  const aliasReserve = Math.min(1400, Math.floor(maxChars * 0.28));
  const priorityBudget = Math.max(400, maxChars - aliasReserve);
  const priorityText = truncate([header, ...priority.flat()].join("\n"), priorityBudget);

  const remaining = maxChars - priorityText.length - 1;
  let aliasBlock = aliases.join("\n");
  if (aliasBlock.length > remaining) {
    aliasBlock = `${aliasBlock.slice(0, Math.max(0, remaining - 20))}\n…[truncated]`;
  }
  return truncate(`${priorityText}\n${aliasBlock}`, maxChars);
}

/** Summarize on-disk domain packs for the assistant system prompt. */
export function loadAssistantDomainPack(options?: {
  dataDir?: string | null;
  maxChars?: number;
}): string {
  const dataDir = options?.dataDir ?? null;
  const maxChars = options?.maxChars ?? MAX_DOMAIN_PACK_CHARS;
  const header = "## Domain pack (curated — not training)";

  let aliasLines: string[] = [];
  const aliases = loadAliasEntries(dataDir);
  if (aliases.length) aliasLines = formatAliasLines(aliases);

  const priority = [
    formatStacksSection(dataDir),
    formatConflictsSection(dataDir),
    formatSourceDigestsSection(dataDir),
    formatPackPitfallsSection(dataDir),
  ].filter((s) => s.length > 0);

  if (!aliasLines.length && priority.length === 0) return "";
  return joinUnderBudget(header, priority, aliasLines, maxChars);
}

function writeYaml(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml.dump(data, { lineWidth: 100, noRefs: true }), "utf8");
}

function writeText(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

export type DomainImportResult = {
  wrote_files: boolean;
  root: string | null;
  notes_created: number;
  sources_written: string[];
  sources_matched_for_notes: number;
};

/**
 * Import a research payload into assistant-domain/ and optionally create source notes.
 * When a live source matches `source_name`, upserts Advisor notes from workflow/pitfalls/quotes
 * (payload fields and/or on-disk files). Optionally backfills all matching pack sources.
 */
export function importAssistantDomainPack(
  payload: DomainImportPayload,
  options: { dataDir: string; repo?: AppRepository | null },
): DomainImportResult {
  const writeFiles = payload.write_files !== false;
  const root = join(options.dataDir, "assistant-domain");
  const sourcesWritten: string[] = [];
  let notesCreated = 0;
  const matchedSourceIds = new Set<number>();

  if (writeFiles) {
    mkdirSync(join(root, "_global"), { recursive: true });
    mkdirSync(join(root, "sources"), { recursive: true });

    if (payload.global?.alias_map != null) {
      writeYaml(join(root, "_global", "alias_map.yaml"), payload.global.alias_map);
    }
    if (payload.global?.stacks != null) {
      writeYaml(join(root, "_global", "stacks.yaml"), payload.global.stacks);
    }
    if (payload.global?.merge_conflicts != null) {
      writeYaml(join(root, "_global", "merge_conflicts.yaml"), payload.global.merge_conflicts);
    }
    if (typeof payload.global?.pitfalls_md === "string") {
      writeText(join(root, "_global", "pitfalls.md"), payload.global.pitfalls_md);
    }
  }

  for (const src of payload.sources ?? []) {
    const name = String(src.source_name ?? "").trim();
    if (!name) continue;
    const dir = join(root, "sources", name);
    if (writeFiles) {
      mkdirSync(dir, { recursive: true });
      if (src.identity != null) writeYaml(join(dir, "identity.yaml"), src.identity);
      if (src.compatibility != null) {
        writeYaml(join(dir, "compatibility.yaml"), src.compatibility);
      }
      if (typeof src.workflow_md === "string") {
        writeText(join(dir, "workflow.md"), src.workflow_md);
      }
      if (typeof src.pitfalls_md === "string") {
        writeText(join(dir, "pitfalls.md"), src.pitfalls_md);
      }
      if (typeof src.quotes_md === "string") {
        writeText(join(dir, "quotes.md"), src.quotes_md);
      }
      sourcesWritten.push(name);
    }

    if (!options.repo) continue;
    const match = options.repo.listSources().find((s) => s.name === name);
    if (!match) continue;
    matchedSourceIds.add(match.id);

    const packDir = findSourcePackDir(options.dataDir, name);
    const workflowBody =
      (typeof src.workflow_md === "string" ? src.workflow_md : null) ??
      (writeFiles ? readText(join(dir, "workflow.md")) : null) ??
      (packDir ? readText(join(packDir, "workflow.md")) : null);
    const pitfallsBody =
      (typeof src.pitfalls_md === "string" ? src.pitfalls_md : null) ??
      (writeFiles ? readText(join(dir, "pitfalls.md")) : null) ??
      (packDir ? readText(join(packDir, "pitfalls.md")) : null);
    const quotesBody =
      (typeof src.quotes_md === "string" ? src.quotes_md : null) ??
      (writeFiles ? readText(join(dir, "quotes.md")) : null) ??
      (packDir ? readText(join(packDir, "quotes.md")) : null);

    notesCreated += upsertAdvisorNotesFromMarkdown(options.repo, match.id, {
      workflow: workflowBody,
      pitfalls: pitfallsBody,
      quotes: quotesBody,
    });

    if (src.notes?.length) {
      for (const note of src.notes) {
        const title = String(note.title ?? "").trim() || "Imported note";
        const body = String(note.body_markdown ?? "").trim();
        if (!body) continue;
        if (upsertAdvisorSourceNote(options.repo, match.id, title, body)) {
          notesCreated += 1;
        }
      }
    }
  }

  let sourcesMatchedForNotes = matchedSourceIds.size;

  const shouldBackfill = options.repo != null && payload.backfill_notes !== false;
  if (shouldBackfill && options.repo) {
    const backfill = backfillAdvisorNotesFromDomainPack(options.repo, options.dataDir);
    sourcesMatchedForNotes = Math.max(sourcesMatchedForNotes, backfill.sources_matched);
    notesCreated = Math.max(notesCreated, backfill.notes_upserted);
  }

  return {
    wrote_files: writeFiles,
    root: writeFiles ? root : null,
    notes_created: notesCreated,
    sources_written: sourcesWritten,
    sources_matched_for_notes: sourcesMatchedForNotes,
  };
}

function findSourcePackDir(dataDir: string | null | undefined, sourceName: string): string | null {
  const name = sourceName.trim();
  const sanitized = name.replace(/\//g, "-");
  for (const root of candidateRoots(dataDir)) {
    for (const dirName of [name, sanitized]) {
      const dir = join(root, "sources", dirName);
      if (existsSync(dir)) return dir;
    }
    const sourcesRoot = join(root, "sources");
    if (!existsSync(sourcesRoot)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(sourcesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const dirName of dirs) {
      const identity = loadYamlFile(join(sourcesRoot, dirName, "identity.yaml")) as SourceIdentity | null;
      if (identity?.source_name === name) return join(sourcesRoot, dirName);
    }
  }
  return null;
}

export function resolveDomainPackDir(dataDir?: string | null): string | null {
  return firstExisting(...candidateRoots(dataDir));
}
