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
const brandMark = readFileSync(
  join(root, "components/layout/BrandMark.tsx"),
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
    expect(darkTokens).toMatch(/--surface-base:\s*hsl\(32\s+10%\s+9%\)/);
    expect(darkTokens).toMatch(/--background:\s*var\(--surface-base\)/);
    expect(darkTokens).toMatch(/--card:\s*var\(--surface-raised\)/);
    expect(darkTokens).toMatch(/--foreground:\s*hsl\(36\s+18%\s+93%\)/);
    expect(darkTokens).toMatch(/--primary:\s*hsl\(36\s+48%\s+52%\)/);
    expect(darkTokens).toMatch(/--primary-foreground:\s*hsl\(32\s+20%\s+10%\)/);
    expect(darkTokens).toMatch(/--muted-foreground:\s*hsl\(32\s+8%\s+66%\)/);
  });

  it("locks light shop daylight tokens", () => {
    expect(lightTokens).toMatch(/--surface-base:\s*hsl\(36\s+28%\s+97%\)/);
    expect(lightTokens).toMatch(/--background:\s*var\(--surface-base\)/);
    expect(lightTokens).toMatch(/--card:\s*var\(--surface-raised\)/);
    expect(lightTokens).toMatch(/--foreground:\s*hsl\(32\s+16%\s+14%\)/);
    expect(lightTokens).toMatch(/--primary:\s*hsl\(34\s+52%\s+38%\)/);
    expect(lightTokens).toMatch(/--primary-foreground:\s*hsl\(36\s+30%\s+98%\)/);
    expect(lightTokens).toMatch(/--muted-foreground:\s*hsl\(32\s+10%\s+38%\)/);
  });

  it("gives both themes the four-step surface ladder", () => {
    for (const tokens of [lightTokens, darkTokens]) {
      for (const step of ["sunken", "base", "raised", "overlay"]) {
        expect(tokens).toMatch(new RegExp(`--surface-${step}:\\s*hsl\\(`));
      }
      // Controls need a boundary that clears 3:1; hairlines stay quiet.
      expect(tokens).toMatch(/--border-strong:\s*hsl\(/);
      expect(tokens).toMatch(/--input:\s*var\(--border-strong\)/);
    }
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
    expect(indexCss).toMatch(/\.desk-canvas\s*\{/);
    expect(indexCss).toMatch(/\.desk-stage-active\s*\{/);
  });
});

describe("elevation, scrim, and status system", () => {
  it("locks AA-passing dark status hues with soft counterparts", () => {
    expect(darkTokens).toMatch(/--success:\s*hsl\(152\s+42%\s+56%\)/);
    expect(darkTokens).toMatch(/--warning:\s*hsl\(38\s+68%\s+58%\)/);
    expect(darkTokens).toMatch(/--info:\s*hsl\(200\s+55%\s+60%\)/);
    expect(darkTokens).toMatch(/--destructive:\s*hsl\(0\s+66%\s+70%\)/);
    // Bright dark-mode fills take dark ink, like --primary-foreground.
    expect(darkTokens).toMatch(/--destructive-foreground:\s*hsl\(32\s+20%\s+10%\)/);
    for (const tokens of [lightTokens, darkTokens]) {
      for (const tone of ["success", "warning", "info", "destructive"]) {
        expect(tokens).toMatch(new RegExp(`--${tone}-soft:\\s*hsl\\(`));
      }
      expect(tokens).toMatch(/--overlay:\s*hsl\(/);
    }
  });

  it("wires Tailwind shadow utilities to the elevation tokens", () => {
    for (const tokens of [lightTokens, darkTokens]) {
      expect(tokens).toMatch(/--elevation-sm:/);
      expect(tokens).toMatch(/--elevation-md:/);
      expect(tokens).toMatch(/--elevation-lg:/);
      expect(tokens).not.toMatch(/--shadow-(sm|md|lg|card):/);
    }
    expect(indexCss).toMatch(/--shadow-sm:\s*var\(--elevation-sm\)/);
    expect(indexCss).toMatch(/--shadow-md:\s*var\(--elevation-md\)/);
    expect(indexCss).toMatch(/--shadow-lg:\s*var\(--elevation-lg\)/);
    expect(indexCss).toMatch(/--color-overlay:\s*var\(--overlay\)/);
  });

  it("keeps the type scale above the 11px floor", () => {
    // text-3xs used to be 10px. Both micro aliases now resolve to 11px.
    expect(indexCss).toMatch(/--text-micro:\s*0\.6875rem/);
    expect(indexCss).toMatch(/--text-2xs:\s*0\.6875rem/);
    expect(indexCss).toMatch(/--text-3xs:\s*0\.6875rem/);
    for (const step of ["meta", "body", "lead", "title", "section", "page"]) {
      expect(indexCss).toMatch(new RegExp(`--text-${step}:\\s*\\d`));
      expect(indexCss).toMatch(new RegExp(`--text-${step}--line-height:\\s*\\d`));
    }
  });

  it("publishes motion and rhythm tokens instead of per-page guesses", () => {
    expect(indexCss).toMatch(/--motion-fast:\s*\d+ms/);
    expect(indexCss).toMatch(/--motion-base:\s*\d+ms/);
    expect(indexCss).toMatch(/--motion-slow:\s*\d+ms/);
    expect(indexCss).toMatch(/--default-transition-duration:\s*var\(--motion-base\)/);
    expect(indexCss).toMatch(/--space-row:/);
    expect(indexCss).toMatch(/--space-section:/);
    expect(indexCss).toMatch(/--space-page:/);
    expect(indexCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("drops the dead accent-bar rule", () => {
    expect(indexCss).not.toMatch(/\.page-accent-bar\s*\{/);
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
  it("uses the PrintPartner wordmark without pipeline brand copy", () => {
    expect(spineRail).toMatch(/PrintPartner/);
    expect(spineRail).not.toMatch(
      /Library\s*→\s*Plan\s*→\s*Parts\s*→\s*Progress\s*→\s*Export/,
    );
  });

  it("uses the generated PrintPartner mark in expanded and collapsed chrome", () => {
    expect(brandMark).toMatch(/aria-hidden/);
    expect(brandMark).toMatch(/print-partner-mark\.png/);
    expect(brandMark).not.toMatch(/<Printer\b/);
    expect(brandMark).not.toMatch(/>\s*PP\s*</);
    expect(spineRail).toMatch(/LayeredSheetMark/);
    expect(spineRail).not.toMatch(/>\s*PP\s*</);
  });

  it("wordmark uses Source Serif 4 with compact tracking when expanded", () => {
    expect(spineRail).toMatch(/font-serif|Source Serif 4|font-\[family/);
    expect(spineRail).toMatch(/text-base/);
    expect(spineRail).toMatch(/tracking-\[-0\.02em\]/);
  });
});

describe("brand assets", () => {
  it("keeps PWA chrome on the desk ink brand color", () => {
    const manifest = readFileSync(join(root, "../public/manifest.json"), "utf8");
    expect(manifest).toMatch(/"theme_color":\s*"#191714"/);
    expect(manifest).toMatch(/"background_color":\s*"#191714"/);
    expect(indexHtml).toMatch(/<meta name="theme-color" content="#191714"/);
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
