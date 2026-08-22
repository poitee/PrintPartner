#!/usr/bin/env tsx
/**
 * One-shot import from desktop ~/.print-partner into a self-host web data directory.
 *
 * Usage:
 *   npx tsx web/scripts/import-sqlite.ts [--source-db PATH] [--source-repos PATH] [--dest DIR]
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteDatabase } from "../apps/server/src/db/client.js";

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  return fallback;
}

const desktopRoot = join(homedir(), ".print-partner");
const sourceDb = arg("--source-db", join(desktopRoot, "print-partner.db"));
const sourceRepos = arg("--source-repos", join(desktopRoot, "repos"));
const destDir = arg("--dest", join(process.cwd(), "data"));

if (!existsSync(sourceDb)) {
  console.error(`Source database not found: ${sourceDb}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
cpSync(sourceDb, join(destDir, "print-partner.db"));
if (existsSync(sourceRepos)) {
  cpSync(sourceRepos, join(destDir, "repos"), { recursive: true });
}

const sqlite = new SqliteDatabase(destDir);
sqlite.connect();
console.log(`Imported desktop data into ${destDir}`);
console.log(`  DB: ${sqlite.dbPath}`);
console.log(`  Repos: ${sqlite.reposDir}`);
sqlite.close();
