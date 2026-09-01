import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Status-color drift lock. Feature code must color status through the
 * semantic tokens (success / warning / info / destructive and their -soft
 * counterparts, or lib/statusTone.ts) — never through raw Tailwind palette
 * classes, which bypass theming and forced dark: overrides in the past.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Deliberate leftovers (always-dark 3D surfaces use literal white/black). */
const ALLOWLIST = new Set<string>([]);

const RAW_PALETTE = /(?:^|[\s"'`:])(?:hover:|focus:|dark:|group-hover:)*(?:text|bg|border|ring|from|to|via|fill|stroke)-(?:amber|emerald|sky|green|rose|slate|red|blue|indigo|teal|lime|orange|fuchsia|violet|cyan)-\d{2,3}\b/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(tsx?|css)$/.test(entry) && !/\.test\./.test(entry)) yield full;
  }
}

describe("status color drift lock", () => {
  it("keeps raw Tailwind palette classes out of components and pages", () => {
    const offenders: string[] = [];
    for (const base of ["components", "pages", "layout"]) {
      for (const file of walk(join(root, base))) {
        const rel = relative(root, file);
        if (ALLOWLIST.has(rel)) continue;
        const source = readFileSync(file, "utf8");
        const match = RAW_PALETTE.exec(source);
        if (match) offenders.push(`${rel}: ${match[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Border-alpha drift lock. `lib/statusTone.ts` owns the alpha a status border
 * is drawn at (/40 for a tinted surface, /50 for a rim or an outline chip).
 * Before it did, the same banner appeared at /25, /30, /35, /40, /50 and /60
 * across the app, so "warning" meant a different weight of orange on every
 * screen. Feature code asks for a tone and an emphasis; only statusTone spells
 * out the number.
 */
const STATUS_BORDER_ALPHA = /border-(?:success|warning|info|destructive)\/\d+/;

/**
 * Owned by the plate/preview workstream — sweep these when that branch lands.
 * Nothing else belongs here: a new entry means a call site went around
 * statusTone rather than extending it.
 */
const BORDER_ALPHA_ALLOWLIST = new Set<string>([
  "components/checkoff/PhaseProgressView.tsx",
  "components/export/accepted-plates/AcceptedPlateAssignmentForm.tsx",
  "components/export/accepted-plates/AcceptedPlateSection.tsx",
]);

describe("status border drift lock", () => {
  it("keeps status border alphas inside lib/statusTone.ts", () => {
    const offenders: string[] = [];
    for (const base of ["components", "pages", "layout", "lib"]) {
      for (const file of walk(join(root, base))) {
        const rel = relative(root, file);
        if (rel === join("lib", "statusTone.ts")) continue;
        if (BORDER_ALPHA_ALLOWLIST.has(rel)) continue;
        const match = STATUS_BORDER_ALPHA.exec(readFileSync(file, "utf8"));
        if (match) offenders.push(`${rel}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
