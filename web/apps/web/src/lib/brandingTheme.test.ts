import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Print Partner "Instrument" branding lock: a neutral graphite carrier with a
 * single signal-cyan accent. Tokens, type, and spine chrome contracts live in
 * source so the palette cannot silently drift back to Voron red / DM Sans /
 * pipeline tagline, or back to a warm accent sitting on top of --warning.
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
  it("locks the dark graphite carrier and signal accent", () => {
    expect(darkTokens).toMatch(/--surface-base:\s*hsl\(220\s+8%\s+11%\)/);
    expect(darkTokens).toMatch(/--background:\s*var\(--surface-base\)/);
    expect(darkTokens).toMatch(/--card:\s*var\(--surface-raised\)/);
    expect(darkTokens).toMatch(/--foreground:\s*hsl\(220\s+14%\s+95%\)/);
    expect(darkTokens).toMatch(/--primary:\s*hsl\(190\s+72%\s+60%\)/);
    expect(darkTokens).toMatch(/--primary-foreground:\s*hsl\(200\s+40%\s+9%\)/);
    expect(darkTokens).toMatch(/--muted-foreground:\s*hsl\(220\s+9%\s+68%\)/);
  });

  it("locks the light graphite carrier and signal accent", () => {
    expect(lightTokens).toMatch(/--surface-base:\s*hsl\(220\s+22%\s+97%\)/);
    expect(lightTokens).toMatch(/--background:\s*var\(--surface-base\)/);
    expect(lightTokens).toMatch(/--card:\s*var\(--surface-raised\)/);
    expect(lightTokens).toMatch(/--foreground:\s*hsl\(220\s+20%\s+13%\)/);
    expect(lightTokens).toMatch(/--primary:\s*hsl\(196\s+92%\s+28%\)/);
    expect(lightTokens).toMatch(/--primary-foreground:\s*hsl\(200\s+30%\s+98%\)/);
    expect(lightTokens).toMatch(/--muted-foreground:\s*hsl\(220\s+10%\s+37%\)/);
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
    expect(darkTokens).toMatch(/--success:\s*hsl\(146\s+48%\s+58%\)/);
    expect(darkTokens).toMatch(/--warning:\s*hsl\(40\s+88%\s+62%\)/);
    expect(darkTokens).toMatch(/--info:\s*hsl\(212\s+74%\s+68%\)/);
    expect(darkTokens).toMatch(/--destructive:\s*hsl\(4\s+78%\s+72%\)/);
    // Bright dark-mode fills take dark ink, like --primary-foreground.
    expect(darkTokens).toMatch(/--destructive-foreground:\s*hsl\(4\s+40%\s+10%\)/);
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

/**
 * The previous palette put --primary at the same hue as --warning (0 degrees
 * apart in light, 2 in dark), so a brand accent and a warning chip were the
 * same colour and the app read as one warm wash. Separation is the property
 * that mattered, so assert the property rather than the hex.
 */
describe("accent and status hues stay distinguishable", () => {
  function hueOf(tokens: string, name: string): number {
    const match = new RegExp(`--${name}:\\s*hsl\\(\\s*([\\d.]+)`).exec(tokens);
    expect(match, `no hsl hue for --${name}`).toBeTruthy();
    return Number(match![1]);
  }

  function separation(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
  }

  it.each([
    ["light", () => lightTokens],
    ["dark", () => darkTokens],
  ])("keeps --primary clear of every status hue in %s", (_theme, get) => {
    const tokens = get();
    const primary = hueOf(tokens, "primary");
    for (const tone of ["success", "warning", "info", "destructive"]) {
      expect(separation(primary, hueOf(tokens, tone))).toBeGreaterThanOrEqual(15);
    }
  });

  it.each([
    ["light", () => lightTokens],
    ["dark", () => darkTokens],
  ])("keeps warning and destructive apart in %s", (_theme, get) => {
    const tokens = get();
    expect(
      separation(hueOf(tokens, "warning"), hueOf(tokens, "destructive")),
    ).toBeGreaterThanOrEqual(20);
  });
});

describe("GRE-234 type", () => {
  it("loads the IBM Plex family and drops the previous stack", () => {
    for (const source of [indexHtml, indexCss]) {
      expect(source).not.toMatch(/DM\+Sans|DM Sans/);
      expect(source).not.toMatch(/JetBrains\+Mono|JetBrains Mono/);
      expect(source).not.toMatch(/Source\+Sans\+3|Source Sans 3/);
      expect(source).not.toMatch(/Source\+Serif\+4|Source Serif 4/);
      expect(source).toMatch(/IBM\+Plex\+Sans|IBM Plex Sans/);
      expect(source).toMatch(/IBM\+Plex\+Mono|IBM Plex Mono/);
    }
    expect(indexCss).toMatch(/--font-sans:\s*"IBM Plex Sans"/);
    // The serif slot is retained so `font-serif` call sites keep resolving.
    expect(indexCss).toMatch(/--font-serif:\s*"IBM Plex Sans"/);
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

  it("wordmark keeps the display slot and compact tracking when expanded", () => {
    expect(spineRail).toMatch(/font-serif|Source Serif 4|font-\[family/);
    expect(spineRail).toMatch(/text-base/);
    expect(spineRail).toMatch(/tracking-\[-0\.02em\]/);
  });
});

describe("brand assets", () => {
  it("keeps PWA chrome on the dark carrier brand color", () => {
    const manifest = readFileSync(join(root, "../public/manifest.json"), "utf8");
    // #1a1b1e is dark --surface-base, hand-duplicated in three files.
    expect(manifest).toMatch(/"theme_color":\s*"#1a1b1e"/);
    expect(manifest).toMatch(/"background_color":\s*"#1a1b1e"/);
    expect(indexHtml).toMatch(/<meta name="theme-color" content="#1a1b1e"/);
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
