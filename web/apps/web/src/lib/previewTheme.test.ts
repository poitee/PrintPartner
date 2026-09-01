// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blendColor,
  contrastRatio,
  previewTheme,
  rampColor,
  readableForeground,
  refreshPreviewTheme,
  resolvePreviewTheme,
  subscribePreviewTheme,
} from "./previewTheme";

const TOKENS = {
  "--media-bg": "#101214",
  "--surface-sunken": "#0b0c0e",
  "--foreground": "#f0f1f4",
  "--muted-foreground": "#a4a9b3",
  "--primary": "#4fd0e6",
  "--border": "#43464c",
  "--border-strong": "#7b8189",
  "--warning": "#f4b942",
  "--info": "#6fa8ea",
  "--success": "#61c68d",
  "--destructive": "#f28a80",
} as const;

function applyTokens(overrides: Record<string, string> = {}) {
  for (const [name, value] of Object.entries({ ...TOKENS, ...overrides })) {
    document.documentElement.style.setProperty(name, value);
  }
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function distance(a: string, b: string): number {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.classList.remove("dark");
});

describe("previewTheme", () => {
  it("reads preview colours off the document tokens", () => {
    applyTokens();
    const theme = resolvePreviewTheme();

    expect(theme.background).toBe("#101214");
    expect(theme.dimension).toBe("#f4b942");
    expect(theme.outline).toBe("#7b8189");
    expect(theme.accent).toBe("#4fd0e6");
    expect(theme.grid).toEqual({ major: "#7b8189", minor: "#43464c" });
  });

  it("follows the dark class on the document element", () => {
    applyTokens();
    expect(resolvePreviewTheme().mode).toBe("light");
    document.documentElement.classList.add("dark");
    expect(resolvePreviewTheme().mode).toBe("dark");
  });

  it("keeps the rig hue-only so the theme cannot tint a filament colour", () => {
    // A saturated warm pole must still light the model with near-white.
    applyTokens({ "--warning": "#ff0000", "--info": "#0000ff" });
    const theme = resolvePreviewTheme();

    for (const light of [theme.rig.ambient, theme.rig.key, theme.rig.fill]) {
      const [r, g, b] = channels(light.color);
      expect(Math.min(r, g, b)).toBeGreaterThan(225);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(26);
    }
  });

  it("exposes the same rig photometrics in both themes", () => {
    applyTokens();
    const light = resolvePreviewTheme();
    document.documentElement.classList.add("dark");
    const dark = resolvePreviewTheme();

    expect(dark.rig.ambient.intensity).toBe(light.rig.ambient.intensity);
    expect(dark.rig.key.intensity).toBe(light.rig.key.intensity);
    expect(dark.rig.fill.intensity).toBe(light.rig.fill.intensity);
    expect(dark.material).toEqual(light.material);
  });

  it("keeps five or fewer Plate ramp entries apart, and clear of the accent", () => {
    for (const mode of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", mode === "dark");
      applyTokens();
      const theme = resolvePreviewTheme();
      const common = theme.ramp.slice(0, 5);

      expect(new Set(common).size).toBe(5);
      for (const [index, color] of common.entries()) {
        // Selection uses --primary, so a unit fill must never look like it.
        expect(distance(color, theme.accent)).toBeGreaterThan(40);
        for (const other of common.slice(index + 1)) {
          expect(distance(color, other)).toBeGreaterThan(40);
        }
      }
    }
  });

  it("separates the plate ramp from the backdrop", () => {
    applyTokens();
    const theme = resolvePreviewTheme();
    for (let index = 0; index < 5; index += 1) {
      expect(contrastRatio(rampColor(theme, index), theme.background)).toBeGreaterThan(2.5);
    }
  });

  it("wraps the ramp for negative and oversized indexes", () => {
    applyTokens();
    const theme = resolvePreviewTheme();
    expect(rampColor(theme, theme.ramp.length)).toBe(theme.ramp[0]);
    expect(rampColor(theme, -1)).toBe(theme.ramp[theme.ramp.length - 1]);
  });

  it("picks readable ink for an arbitrary swatch colour", () => {
    applyTokens();
    const theme = resolvePreviewTheme();

    const onPale = readableForeground("#fde68a", theme);
    const onDeep = readableForeground("#1d4ed8", theme);
    expect(contrastRatio("#fde68a", onPale)).toBeGreaterThan(4.5);
    expect(contrastRatio("#1d4ed8", onDeep)).toBeGreaterThan(4.5);
    expect(onPale).not.toBe(onDeep);
  });

  it("judges ink against a translucent fill's flattened colour", () => {
    applyTokens();
    const theme = resolvePreviewTheme();
    expect(blendColor("#ffffff", "#000000", 0.5)).toBe("#808080");

    // The same fill at low opacity over a dark bed needs the opposite ink.
    const painted = blendColor("#f4b942", theme.background, 0.2);
    expect(readableForeground(painted, theme)).not.toBe(
      readableForeground("#f4b942", theme),
    );
  });

  it("re-resolves and notifies when the document theme changes", async () => {
    applyTokens();
    const listener = vi.fn();
    const unsubscribe = subscribePreviewTheme(listener);
    expect(previewTheme().background).toBe("#101214");

    document.documentElement.style.setProperty("--media-bg", "#e3e5e8");
    document.documentElement.classList.add("dark");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listener).toHaveBeenCalled();
    expect(previewTheme().background).toBe("#e3e5e8");
    unsubscribe();
  });

  it("falls back to neutral greys when no stylesheet is loaded", () => {
    const theme = refreshPreviewTheme();
    expect(theme.background).toMatch(/^#[0-9a-f]{6}$/);
    const [r, g, b] = channels(theme.background);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(8);
  });
});
