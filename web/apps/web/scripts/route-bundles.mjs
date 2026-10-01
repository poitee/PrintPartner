#!/usr/bin/env node
// Reports the JavaScript each route downloads before it renders and fails when
// three.js leaks into a route's static import closure. Run after `vite build --manifest`.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8"));

function staticClosure(key, seen = new Set()) {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const next of manifest[key].imports ?? []) staticClosure(next, seen);
  return seen;
}

const fileCache = new Map();
function file(key) {
  const name = manifest[key].file;
  if (!fileCache.has(name)) {
    const bytes = readFileSync(join(dist, name));
    fileCache.set(name, {
      raw: statSync(join(dist, name)).size,
      gzip: gzipSync(bytes).length,
      hasThree: bytes.includes("WebGLRenderer"),
    });
  }
  return fileCache.get(name);
}

const sum = (keys, field) => [...keys].reduce((total, key) => total + file(key)[field], 0);
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

const entry = Object.keys(manifest).find((key) => manifest[key].isEntry);
const shell = Object.keys(manifest).find((key) => key.endsWith("src/AuthenticatedApp.tsx"));
const publicBase = staticClosure(entry);
const authenticatedBase = new Set([...publicBase, ...staticClosure(shell)]);
const publicPages = new Set([
  "src/pages/LoginPage.tsx",
  "src/pages/ForgotPasswordPage.tsx",
  "src/pages/ResetPasswordPage.tsx",
]);
const pages = Object.keys(manifest)
  .filter((key) => /src\/pages\/\w+\.tsx$/.test(key))
  .sort();

const rows = [
  ["route", "baseline", "raw", "gzip", "three.js"],
  ["(public visits)", "", kb(sum(publicBase, "raw")), kb(sum(publicBase, "gzip")), ""],
  ["(authenticated visits)", "", kb(sum(authenticatedBase, "raw")), kb(sum(authenticatedBase, "gzip")), ""],
];
const leaks = [];
for (const page of pages) {
  const isPublic = publicPages.has(page);
  const base = isPublic ? publicBase : authenticatedBase;
  const extra = new Set([...staticClosure(page)].filter((key) => !base.has(key)));
  const three = [...staticClosure(page)].some((key) => file(key).hasThree);
  if (three) leaks.push(page);
  rows.push([page.replace(/^src\/pages\//, ""), isPublic ? "public" : "authenticated", `+${kb(sum(extra, "raw"))}`, `+${kb(sum(extra, "gzip"))}`, three ? "static" : ""]);
}
for (const [label, base] of [["public visits", publicBase], ["authenticated visits", authenticatedBase]]) {
  if ([...base].some((key) => file(key).hasThree)) leaks.push(`(${label})`);
}

const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
for (const row of rows) process.stdout.write(`${row.map((cell, column) => cell.padEnd(widths[column])).join("  ")}\n`);

if (leaks.length) {
  process.stderr.write(`\nthree.js is in the static import closure of: ${leaks.join(", ")}. Load 3D code with lazy() or import().\n`);
  process.exit(1);
}
