#!/usr/bin/env node
/**
 * Emit the text-contrast tables in docs/design-system.md from the tokens that
 * actually ship in web/apps/web/src/index.css.
 *
 * The tables were hand-maintained and drifted: the dark muted-foreground row
 * described a token value that had already changed. Run this after any palette
 * edit and paste the output, or diff it to prove the doc still matches.
 *
 *   node web/scripts/design-system-contrast.mjs
 *   node web/scripts/design-system-contrast.mjs --check
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "../apps/web/src/index.css");
const docPath = join(here, "../../docs/design-system.md");

const SURFACES = ["surface-sunken", "surface-base", "surface-raised", "surface-overlay"];
const INKS = [
  ["foreground", "foreground"],
  ["muted-foreground", "muted-foreground"],
  ["primary", "primary (signal cyan, also the focus ring)"],
  ["success", "success"],
  ["warning", "warning"],
  ["info", "info"],
  ["destructive", "destructive"],
  ["border-strong", "border-strong"],
];

/** Body of the first top-level rule with this exact selector. */
function ruleBody(source, selector) {
  const start = source.search(new RegExp(`(^|\\n)${selector}\\s*\\{`, "m"));
  if (start < 0) throw new Error(`missing rule ${selector}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unclosed rule ${selector}`);
}

function tokens(body) {
  const found = new Map();
  const re = /--([\w-]+):\s*hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/g;
  for (const [, name, h, s, l] of body.matchAll(re)) {
    found.set(name, [Number(h), Number(s), Number(l)]);
  }
  return found;
}

function hslToRgb([h, s, l]) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][Math.floor(h / 60) % 6];
  return [r + m, g + m, b + m];
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function table(theme, base) {
  const rows = [
    "| Ink | sunken | base | raised | overlay |",
    "| --- | --- | --- | --- | --- |",
  ];
  let floor = Infinity;
  for (const [name, label] of INKS) {
    const ink = theme.get(name) ?? base.get(name);
    if (!ink) continue;
    const cells = SURFACES.map((s) => {
      const surface = theme.get(s) ?? base.get(s);
      const r = ratio(hslToRgb(ink), hslToRgb(surface));
      if (name !== "border-strong") floor = Math.min(floor, r);
      return r.toFixed(2);
    });
    rows.push(`| ${label} | ${cells.join(" | ")} |`);
  }
  return { markdown: rows.join("\n"), floor };
}

const css = readFileSync(cssPath, "utf8");
const light = tokens(ruleBody(css, ":root"));
const dark = tokens(ruleBody(css, "\\.dark"));

const darkTable = table(dark, light);
const lightTable = table(light, light);

const out = [
  "Dark:", "", darkTable.markdown, "",
  "Light:", "", lightTable.markdown, "",
  `Text floor: dark ${darkTable.floor.toFixed(2)}, light ${lightTable.floor.toFixed(2)}.`,
].join("\n");

if (process.argv.includes("--check")) {
  const doc = readFileSync(docPath, "utf8");
  const stale = [...darkTable.markdown.split("\n"), ...lightTable.markdown.split("\n")]
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !doc.includes(line));
  if (stale.length) {
    process.stderr.write(
      `docs/design-system.md is stale. ${stale.length} row(s) do not match index.css:\n`,
    );
    for (const line of stale) process.stderr.write(`  ${line}\n`);
    process.exit(1);
  }
  process.stdout.write("docs/design-system.md contrast tables match index.css\n");
} else {
  process.stdout.write(`${out}\n`);
}
