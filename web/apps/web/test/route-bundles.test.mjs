import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";

function fixture(t, rendererChunk) {
  const root = mkdtempSync(join(tmpdir(), "pp-route-bundles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "dist", ".vite"), { recursive: true });
  mkdirSync(join(root, "dist", "assets"));
  const script = join(root, "scripts", "route-bundles.mjs");
  copyFileSync(new URL("../scripts/route-bundles.mjs", import.meta.url), script);
  const manifest = {
    "index.html": { isEntry: true, file: "assets/entry.js", imports: ["shared"] },
    "shared": { file: "assets/shared.js" },
    "src/AuthenticatedApp.tsx": { file: "assets/shell.js", imports: ["shared", "authenticated"] },
    "authenticated": { file: "assets/authenticated.js" },
    "src/pages/LoginPage.tsx": { file: "assets/login.js", imports: ["shared", "public"], dynamicImports: ["preview"] },
    "src/pages/ForgotPasswordPage.tsx": { file: "assets/forgot.js", imports: ["shared", "public"] },
    "src/pages/ResetPasswordPage.tsx": { file: "assets/reset.js", imports: ["shared", "public"] },
    "public": { file: "assets/public.js" },
    "src/pages/PartsPage.tsx": { file: "assets/parts.js", imports: ["shared", "authenticated"], dynamicImports: ["preview"] },
    "preview": { file: "assets/preview.js" },
  };
  writeFileSync(join(root, "dist", ".vite", "manifest.json"), JSON.stringify(manifest));
  for (const entry of Object.values(manifest)) {
    const renderer = entry.file === "assets/preview.js" || entry.file === rendererChunk;
    const contents = (renderer ? "WebGLRenderer" : "a").padEnd(1024, "a");
    writeFileSync(join(root, "dist", entry.file), contents);
  }
  return script;
}

test("public pages exclude the authenticated shell and dynamic previews", (t) => {
  const output = execFileSync(process.execPath, [fixture(t)], { encoding: "utf8" });
  assert.match(output, /\(public visits\)\s+2 KB/);
  assert.match(output, /\(authenticated visits\)\s+4 KB/);
  for (const page of ["LoginPage", "ForgotPasswordPage", "ResetPasswordPage"]) {
    assert.match(output, new RegExp(`${page}\\.tsx\\s+public\\s+\\+2 KB`));
  }
  assert.match(output, /PartsPage\.tsx\s+authenticated\s+\+1 KB/);
});

test("three.js in an authenticated shell dependency fails the check", (t) => {
  assert.throws(() => execFileSync(process.execPath, [fixture(t, "assets/authenticated.js")], { stdio: "pipe" }),
    (error) => error.status === 1 && error.stderr.toString().includes("(authenticated visits)"));
});

test("three.js in a public page dependency fails the check", (t) => {
  assert.throws(() => execFileSync(process.execPath, [fixture(t, "assets/public.js")], { stdio: "pipe" }),
    (error) => error.status === 1 && error.stderr.toString().includes("src/pages/LoginPage.tsx"));
});
