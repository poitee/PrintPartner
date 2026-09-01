/**
 * Ink on paper. Deliberately theme-independent: a printed checklist goes on a
 * shop wall, so it must not follow the app's light/dark chrome or its brand.
 *
 * This is the source of truth for anything that renders a sheet outside the
 * browser's CSS — today that is the server's HTML checklist export. The web
 * app reads the same values as `--paper-*` custom properties in
 * `apps/web/src/index.css`; `paper-palette.test.ts` asserts the two agree, so
 * the server export cannot silently keep an old brand the way it did when it
 * carried its own warm-brass literals.
 */
export const PAPER = {
  bg: "#ffffff",
  fg: "#111827",
  muted: "#6b7280",
  mutedFg: "#374151",
  border: "#d1d5db",
  borderStrong: "#9ca3af",
  surface: "#f9fafb",
  surfaceHover: "#f3f4f6",
  focus: "#2563eb",

  successBg: "#f0fdf4",
  successChipBg: "#dcfce7",
  successBorder: "#86efac",
  successFg: "#166534",

  destructive: "#dc2626",
  destructiveHover: "#b91c1c",
  destructiveBorder: "#fca5a5",
  destructiveBorderHover: "#f87171",
  destructiveBgHover: "#fef2f2",
} as const;

export type PaperPalette = typeof PAPER;

/** The `--paper-*` custom property name each key maps to in `index.css`. */
export const PAPER_CSS_VARIABLES: Readonly<Record<keyof PaperPalette, string>> = {
  bg: "--paper-bg",
  fg: "--paper-fg",
  muted: "--paper-muted",
  mutedFg: "--paper-muted-fg",
  border: "--paper-border",
  borderStrong: "--paper-border-strong",
  surface: "--paper-surface",
  surfaceHover: "--paper-surface-hover",
  focus: "--paper-focus",
  successBg: "--paper-success-bg",
  successChipBg: "--paper-success-chip-bg",
  successBorder: "--paper-success-border",
  successFg: "--paper-success-fg",
  destructive: "--paper-destructive",
  destructiveHover: "--paper-destructive-hover",
  destructiveBorder: "--paper-destructive-border",
  destructiveBorderHover: "--paper-destructive-border-hover",
  destructiveBgHover: "--paper-destructive-bg-hover",
};
