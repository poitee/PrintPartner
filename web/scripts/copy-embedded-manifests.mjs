import { cp, mkdir, rm } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const source = fileURLToPath(
  new URL("../apps/server/src/data/manifests/", import.meta.url),
);
const target = fileURLToPath(
  new URL("../apps/server/dist/data/manifests/", import.meta.url),
);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

process.stdout.write(`Copied embedded manifests from ${source} to ${target}\n`);
