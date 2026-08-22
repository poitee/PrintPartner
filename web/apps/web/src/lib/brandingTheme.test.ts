import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * GRE-234: Print Partner desk ink / paper / brass branding lock.
 * Tokens + type + spine chrome contracts live in source so the palette
 * cannot silently drift back to Voron red / DM Sans / pipeline tagline.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexCss = readFileSync(join(root, "index.css"), "utf8");
const indexHtml = readFileSync(join(root, "../index.html"), "utf8");
const spineRail = readFileSync(
  join(root, "components/layout/SpineRail.tsx"),
  "utf8",
);
const appCss = readFileSync(join(root, "App.css"), "utf8");
const themeContext = readFileSync(join(root, "context/ThemeContext.tsx"), "utf8");

/** Extract the body of the first top-level CSS rule whose selector is exact. */
function ruleBody(source: string, selector: string): string {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\{`, "m");
  const match = re.exec(source);
  expect(match, `missing rule ${selector}`).toBeTruthy();
  const brace = source.indexOf("{", match!.index);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  throw new Error(`unclosed rule ${selector}`);
}

const lightTokens = ruleBody(indexCss, ":root");
const darkTokens = ruleBody(indexCss, ".dark");

describe("GRE-234 branding tokens", () => {
  it("locks dark desk ink / paper / brass", () => {
    expect(darkTokens).toMatch(/--background:\s*hsl\(32\s+10%\s+9%\)/);
    expect(darkTokens).toMatch(/--card:\s*hsl\(32\s+8%\s+13%\)/);
    expect(darkTokens).toMatch(/--foreground:\s*hsl\(36\s+18%\s+93%\)/);
    expect(darkTokens).toMatch(/--primary:\s*hsl\(36\s+48%\s+52%\)/);
    expect(darkTokens).toMatch(/--primary-foreground:\s*hsl\(32\s+20%\s+10%\)/);
    expect(darkTokens).toMatch(/--muted-foreground:\s*hsl\(32\s+8%\s+62%\)/);
    expect(darkTokens).toMatch(/--border:\s*hsl\(32\s+8%\s+20%\)/);
  });

  it("locks light shop daylight tokens", () => {
    expect(lightTokens).toMatch(/--background:\s*hsl\(36\s+28%\s+97%\)/);
    expect(lightTokens).toMatch(/--foreground:\s*hsl\(32\s+16%\s+14%\)/);
    expect(lightTokens).toMatch(/--card:\s*hsl\(36\s+30%\s+99%\)/);
    expect(lightTokens).toMatch(/--primary:\s*hsl\(34\s+52%\s+38%\)/);
    expect(lightTokens).toMatch(/--primary-foreground:\s*hsl\(36\s+30%\s+98%\)/);
    expect(lightTokens).toMatch(/--muted-foreground:\s*hsl\(32\s+10%\s+38%\)/);
    expect(lightTokens).toMatch(/--border:\s*hsl\(32\s+12%\s+84%\)/);
  });

  it("keeps print paper tokens pure white (no brass bleed)", () => {
    expect(lightTokens).toMatch(/--paper-bg:\s*#ffffff/);
    // Paper group stays on :root only — .dark must not override global paper tokens.
    expect(darkTokens).not.toMatch(/--paper-bg:/);
    expect(darkTokens).not.toMatch(/--paper-fg:/);
    // Screen: dark desk remaps sheet to card tokens (not blinding white).
    expect(appCss).toMatch(
      /@media screen[\s\S]*?\.dark\s+\.checkoff-sheet\s*\{[^}]*--paper-bg:\s*var\(--card\)/s,
    );
    expect(appCss).not.toMatch(/#f0ebe3|#ebe4d9/);
    // Print sheet explicitly paper white; no theme --primary on the sheet.
    expect(appCss).toMatch(
      /@media print[\s\S]*?\.checkoff-sheet\s*\{[^}]*--paper-bg:\s*#ffffff/s,
    );
    expect(appCss).not.toMatch(
      /\.checkoff-sheet\s*\{[^}]*--primary/s,
    );
  });

  it("does not use gradient header / accent bar tokens", () => {
    expect(indexCss).not.toMatch(/--gradient-header:\s*linear-gradient/);
    expect(indexCss).not.toMatch(/--gradient-accent:\s*linear-gradient/);
    expect(indexCss).not.toMatch(/\.page-accent-bar::before[\s\S]*?background:\s*var\(--gradient-accent\)/);
  });
});

describe("GRE-234 type", () => {
  it("loads Source Sans 3 + Source Serif 4 + IBM Plex Mono and drops DM Sans", () => {
    for (const source of [indexHtml, indexCss]) {
      expect(source).not.toMatch(/DM\+Sans|DM Sans/);
      expect(source).toMatch(/Source\+Sans\+3|Source Sans 3/);
      expect(source).toMatch(/Source\+Serif\+4|Source Serif 4/);
      expect(source).toMatch(/IBM\+Plex\+Mono|IBM Plex Mono/);
      expect(source).not.toMatch(/JetBrains\+Mono|JetBrains Mono/);
    }
    expect(indexCss).toMatch(/--font-sans:\s*"Source Sans 3"/);
    expect(indexCss).toMatch(/--font-serif:\s*"Source Serif 4"/);
    expect(indexCss).toMatch(/--font-mono:\s*"IBM Plex Mono"/);
  });
});

describe("GRE-234 spine brand chrome", () => {
  it("uses Print Partner wordmark without pipeline brand copy", () => {
    expect(spineRail).toMatch(/Print Partner/);
    expect(spineRail).not.toMatch(
      /Library\s*→\s*Plan\s*→\s*Parts\s*→\s*Progress\s*→\s*Export/,
    );
  });

  it("collapsed mark is layered sheets, not printer icon or PP", () => {
    expect(spineRail).toMatch(/aria-hidden/);
    expect(spineRail).toMatch(/<rect[\s\S]*width=["']10["'][\s\S]*height=["']12["']/);
    expect(spineRail.match(/<rect[\s\S]*?width=["']10["'][\s\S]*?height=["']12["']/g)?.length).toBeGreaterThanOrEqual(2);
    expect(spineRail).not.toMatch(/BrandMark[\s\S]*?<Printer\b/);
    expect(spineRail).not.toMatch(/>\s*PP\s*</);
  });

  it("wordmark uses Source Serif 4 at 15px / -0.01em when expanded", () => {
    expect(spineRail).toMatch(/font-serif|Source Serif 4|font-\[family/);
    expect(spineRail).toMatch(/text-\[15px\]|15px/);
    expect(spineRail).toMatch(/tracking-\[-0\.01em\]|-0\.01em/);
  });
});

describe("GRE-234 dark default", () => {
  it("defaults Appearance preference to dark", () => {
    expect(themeContext).toMatch(
      /function readStoredPreference\(\)[\s\S]*?return "dark";/,
    );
    expect(indexHtml).toMatch(/var pref = "dark"/);
  });
});
