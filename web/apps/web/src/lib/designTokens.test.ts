import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Runs web/scripts/design-system-contrast.mjs --check, the gate for the token
 * set: fresh generated tables, AA contrast in every variant, one color per
 * printer status, 0 ms reduced motion, and tokens only on rebuilt UI.
 */
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "../../../../scripts/design-system-contrast.mjs");
const files = {
  css: join(here, "../index.css"),
  doc: join(here, "../../../../../docs/design-system.md"),
  status: join(here, "statusTone.ts"),
};

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** Copy the real files, apply `edit`, and run --check against the copies. */
function check(edit?: (paths: typeof files & { rebuild: string }) => void): { ok: boolean; output: string } {
  scratch = mkdtempSync(join(tmpdir(), "design-tokens-"));
  const paths = {
    css: join(scratch, "index.css"),
    doc: join(scratch, "design-system.md"),
    status: join(scratch, "statusTone.ts"),
    rebuild: join(scratch, "rebuild"),
  };
  cpSync(files.css, paths.css);
  cpSync(files.doc, paths.doc);
  cpSync(files.status, paths.status);
  edit?.(paths);
  const args = [script, "--check", "--css", paths.css, "--doc", paths.doc, "--status", paths.status];
  try {
    const output = execFileSync(process.execPath, [...args, "--rebuild-dir", paths.rebuild], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: String((error as { stderr?: string }).stderr) };
  }
}

function replaceIn(path: string, from: string | RegExp, to: string) {
  const before = readFileSync(path, "utf8");
  const after = before.replace(from, to);
  expect(after).not.toBe(before);
  writeFileSync(path, after);
}

describe("design token check", () => {
  it("passes on the shipped tokens and docs", () => {
    const result = check();
    expect(result.output).toContain("design tokens: doc tables fresh");
    expect(result.ok).toBe(true);
  });

  it("fails when the generated tables are stale", () => {
    const result = check(({ css }) => replaceIn(css, "--printer-idle: hsl(220 10% 37%)", "--printer-idle: hsl(220 10% 33%)"));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("token tables are stale");
  });

  it("fails when two printer statuses share a color", () => {
    const result = check(({ css }) => replaceIn(css, "--printer-offline: hsl(275 45% 42%)", "--printer-offline: hsl(220 10% 37%)"));
    expect(result.output).toContain("Light: --printer-offline and --printer-idle share a color");
  });

  it("fails when a printer status has no token or queued becomes a printer status", () => {
    const result = check(({ status }) => replaceIn(status, '"offline",', '"offline",\n  "queued",'));
    expect(result.output).toContain("queued is a job state");
    expect(result.output).toContain("light: missing --printer-queued");
  });

  it("fails when a pair drops below AA in high contrast", () => {
    const result = check(({ css }) => replaceIn(css, "--muted-foreground: hsl(220 14% 24%)", "--muted-foreground: hsl(220 8% 60%)"));
    expect(result.output).toMatch(/Light high contrast: --muted-foreground on --surface-\w+ is [\d.]+:1, below 4.5:1/);
  });

  it("fails when reduced motion leaves a duration above 0 ms", () => {
    const result = check(({ css }) => replaceIn(css, "--motion-slow: 0ms", "--motion-slow: 120ms"));
    expect(result.output).toContain("reduced motion: --motion-slow is not 0ms");
  });

  it("fails when a high-contrast rule escapes the desktop_rebuild scope", () => {
    const result = check(({ css }) => replaceIn(css, /(@media \(prefers-contrast: more\) \{\s*):root\[data-desktop-rebuild\] \{/, "$1:root {"));
    expect(result.output).toContain("@media (prefers-contrast: more) :root: must be under :root[data-desktop-rebuild]");
  });

  it("fails when rebuilt UI uses a raw value", () => {
    const result = check(({ css, rebuild }) => {
      replaceIn(css, "scroll-behavior: auto !important;", "scroll-behavior: auto !important;\n    outline-width: 3px;");
      mkdirSync(rebuild);
      writeFileSync(join(rebuild, "Screen.tsx"), 'export const x = <div className="p-[13px] text-red-600" style={{ color: "#ff0000" }} />;\n');
    });
    expect(result.output).toContain("outline-width: 3px is a raw value");
    expect(result.output).toContain('hex color "#ff0000"');
    expect(result.output).toContain('Tailwind arbitrary value "p-[13px]"');
    expect(result.output).toContain('raw palette class "text-red-600"');
  });
});
