/**
 * Normalize assistant-domain compatibility.yaml (print-partner/compat@1 and legacy sketches).
 */

export type CompatibilityAttach = {
  base: string;
  ref?: string | null;
  path_scope?: string | null;
  note?: string | null;
  confidence?: string | null;
};

export type PartReplacement = {
  from_source?: string | null;
  from_slug_or_path: string;
  to_slug_or_path?: string | null;
};

export type NormalizedCompatibility = {
  source_name: string;
  kind: string | null;
  /** Flat base names (canonical prompt / graph field). */
  attaches_to_bases: string[];
  attaches_to: CompatibilityAttach[];
  /** Mutual exclusion peers (canonical: conflicts_with). */
  conflicts_with: string[];
  not_for: string[];
  replaces_slots: string[];
  /** Prose / freeform replace notes. */
  replaces: string[];
  replaces_parts: PartReplacement[];
  requirements: string[];
  recommended_stacks: string[];
  ldo_pairing: string | null;
  pairing_rules: string[];
};

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        if (o.base != null) return String(o.base).trim();
        if (o.source != null) return String(o.source).trim();
        if (o.name != null) return String(o.name).trim();
      }
      return "";
    })
    .filter(Boolean);
}

function parseAttaches(raw: unknown): CompatibilityAttach[] {
  if (!Array.isArray(raw)) return [];
  const out: CompatibilityAttach[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const base = item.trim();
      if (base) out.push({ base });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const base = o.base != null ? String(o.base).trim() : "";
    if (!base) continue;
    out.push({
      base,
      ref: o.ref != null ? String(o.ref) : null,
      path_scope: o.path_scope != null ? String(o.path_scope) : null,
      note: o.note != null ? String(o.note) : null,
      confidence: o.confidence != null ? String(o.confidence) : null,
    });
  }
  return out;
}

/** Heuristic: pull path-like tokens from prose replace lines. */
function extractPathsFromProse(line: string): PartReplacement[] {
  const out: PartReplacement[] = [];
  // "A -> B" or "A → B"
  const arrow = /^(.+?)\s*(?:->|→)\s*(.+)$/.exec(line.trim());
  if (arrow) {
    const from = arrow[1]!.trim();
    const to = arrow[2]!.trim();
    // Prefer filename-like tokens
    const fromPath = from.match(/[\w./-]+\.stl/i)?.[0] ?? from;
    const toPath = to.match(/[\w./-]+\.stl/i)?.[0] ?? to;
    out.push({
      from_slug_or_path: fromPath,
      to_slug_or_path: toPath,
    });
    return out;
  }
  const stls = line.match(/[\w./-]+\.stl/gi) ?? [];
  for (const p of stls.slice(0, 3)) {
    out.push({ from_slug_or_path: p });
  }
  return out;
}

function parseReplacesParts(raw: unknown, proseReplaces: string[]): PartReplacement[] {
  const out: PartReplacement[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        out.push(...extractPathsFromProse(item));
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const from =
        o.from_slug_or_path != null
          ? String(o.from_slug_or_path).trim()
          : o.from != null
            ? String(o.from).trim()
            : "";
      if (!from) continue;
      out.push({
        from_source: o.from_source != null ? String(o.from_source) : null,
        from_slug_or_path: from,
        to_slug_or_path:
          o.to_slug_or_path != null
            ? String(o.to_slug_or_path)
            : o.to != null
              ? String(o.to)
              : null,
      });
    }
  }
  if (!out.length) {
    for (const line of proseReplaces) {
      out.push(...extractPathsFromProse(line));
    }
  }
  return out;
}

function parseLdoPairing(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return raw.trim() || null;
  if (typeof raw === "object") {
    try {
      return JSON.stringify(raw).slice(0, 200);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

/**
 * Accept research `compat@1` (`attaches_to`, `conflicts`) and ingest-doc sketch
 * (`attaches_to_bases`, `conflicts_with`).
 */
export function normalizeCompatibility(raw: unknown): NormalizedCompatibility | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sourceName =
    o.source_name != null ? String(o.source_name).trim() : o.name != null ? String(o.name).trim() : "";
  if (!sourceName) return null;

  const attaches_to = parseAttaches(o.attaches_to ?? o.attaches_to_bases);
  const basesFromFlat = asStringList(o.attaches_to_bases);
  const attaches_to_bases = [
    ...new Set([...attaches_to.map((a) => a.base), ...basesFromFlat]),
  ];

  const conflicts_with = [
    ...new Set([
      ...asStringList(o.conflicts_with),
      ...asStringList(o.conflicts),
    ]),
  ];

  const not_for = asStringList(o.not_for);
  const replaces_slots = asStringList(o.replaces_slots ?? o.slots);
  const replaces = asStringList(o.replaces);
  const replaces_parts = parseReplacesParts(o.replaces_parts, replaces);
  const requirements = asStringList(o.requirements);
  const recommended_stacks = asStringList(o.recommended_stacks);
  const pairing_rules = asStringList(o.pairing_rules);

  // Infer slots from kind / prose when not explicit
  const kind = o.kind != null ? String(o.kind).trim() : null;
  if (!replaces_slots.length && kind) {
    if (/probe/i.test(kind)) replaces_slots.push("probe");
    else if (/toolhead/i.test(kind)) replaces_slots.push("toolhead");
    else if (/extruder/i.test(kind)) replaces_slots.push("extruder");
    else if (/electronics|controller/i.test(kind)) replaces_slots.push("controller");
  }
  if (!replaces_slots.length) {
    const joined = replaces.join(" ").toLowerCase();
    if (/z[_\s-]?endstop|nozzle_probe|probe/.test(joined)) replaces_slots.push("probe");
    if (/power.?inlet|inlet/.test(joined)) replaces_slots.push("power_inlet");
  }

  return {
    source_name: sourceName,
    kind,
    attaches_to_bases,
    attaches_to,
    conflicts_with,
    not_for,
    replaces_slots: [...new Set(replaces_slots)],
    replaces,
    replaces_parts,
    requirements,
    recommended_stacks,
    ldo_pairing: parseLdoPairing(o.ldo_pairing ?? o.ldo_vs_stock),
    pairing_rules,
  };
}

/** One-line digest for system prompt. */
export function formatCompatibilityDigestLine(c: NormalizedCompatibility): string | null {
  const bits: string[] = [];
  if (c.attaches_to_bases.length) {
    bits.push(`attaches=[${c.attaches_to_bases.slice(0, 4).join(",")}]`);
  }
  if (c.conflicts_with.length) {
    bits.push(`conflicts=[${c.conflicts_with.slice(0, 4).join(",")}]`);
  }
  if (c.replaces_slots.length) {
    bits.push(`slots=[${c.replaces_slots.join(",")}]`);
  }
  if (c.not_for.length) {
    bits.push(`not_for=[${c.not_for.slice(0, 3).join(",")}]`);
  }
  if (c.replaces_parts.length) {
    const sample = c.replaces_parts
      .slice(0, 2)
      .map((p) =>
        p.to_slug_or_path
          ? `${p.from_slug_or_path}→${p.to_slug_or_path}`
          : p.from_slug_or_path,
      )
      .join("; ");
    bits.push(`replaces_parts=${sample}`);
  } else if (c.replaces.length) {
    bits.push(`replaces=${c.replaces[0]!.slice(0, 60)}`);
  }
  if (!bits.length) return null;
  return `  compat: ${bits.join("; ")}`;
}
