import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const marker = "pp-desktop-e2e-marker-gre492";
const plugin = "tauri-plugin-wdio-webdriver v1.5.0";

function cargoTree(features: boolean): Promise<string> {
  const args = [
    "tree",
    "--manifest-path",
    "rust/Cargo.toml",
    "--locked",
    "-p",
    "pp-desktop",
    "-e",
    "normal",
    "--prefix",
    "none",
  ];
  if (features) {
    args.push("--features", "desktop-e2e");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `cargo tree exited ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function binaryContains(binary: string, needle: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const grep = spawn("grep", ["-a", "-F", "-q", needle, binary], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    grep.stderr.setEncoding("utf8");
    grep.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    grep.on("error", reject);
    grep.on("close", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      if (code === 1) {
        resolve(false);
        return;
      }
      reject(new Error(stderr || `grep exited ${code} while scanning ${binary}`));
    });
  });
}

const release = process.argv[2];
const automation = process.argv[3];
if (!release || !automation) {
  throw new Error("usage: assert-release-exclusion.ts <release-binary> <automation-binary>");
}

const plain = await cargoTree(false);
const featured = await cargoTree(true);
if (plain.includes("tauri-plugin-wdio-webdriver")) {
  throw new Error("default pp-desktop tree includes the automation plugin");
}
if (!featured.includes(plugin)) {
  throw new Error(`desktop-e2e tree does not contain ${plugin}`);
}
if (await binaryContains(release, marker)) {
  throw new Error("release binary contains the automation marker");
}
if (!(await binaryContains(automation, marker))) {
  throw new Error("automation binary is missing the automation marker");
}

const receipt = {
  plugin,
  releaseExcludesMarker: true,
  automationHasMarker: true,
  releaseSha256: createHash("sha256").update(readFileSync(release)).digest("hex"),
  automationSha256: createHash("sha256").update(readFileSync(automation)).digest("hex"),
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
