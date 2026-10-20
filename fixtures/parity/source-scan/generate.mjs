// Generate Node document-index results. Run from the repo root, with or without --check.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const source = "web/apps/server/src/services/source-docs-index.ts";
const output = join(here, "source-scan.json");
const inputs = [
  { id: "empty", files: {} },
  { id: "documents", files: { "README.md": "# Instructions\n", "docs/assembly.md": "Fit tab A.\n", "docs/manual.PDF": "%PDF-1.7\n", "part.stl": "solid part" } },
  { id: "ignored", files: { ".git/README.md": "ignored", ".docs-text/cache.md": "ignored", "node_modules/pkg/README.md": "ignored", "docs/README.en.md": "Read me\n", "notes.txt": "ignored" } },
  { id: "utf16", files: { "\ue000.md": "BMP", "😀.md": "astral", "docs/résumé.md": "UTF-8: é\n" } },
];

if (process.argv.includes("--probe")) {
  const { indexSourceDocsFromDisk } = await import(pathToFileURL(join(root, source)).href);
  const route = readFileSync(join(root, "web/apps/server/src/routes/sources.ts"), "utf8");
  const scanFunction = stripTypeScriptTypes(route.slice(route.indexOf("export async function syncProjectById(")), { mode: "transform" }).replace("export ", "");
  const { OwnershipAdmissionError } = await import(pathToFileURL(join(root, "web/apps/server/src/ownership/source-sync-admission.ts")).href);
  const syncProjectById = new Function("indexSourceDocsFromDisk", "OwnershipAdmissionError", `
    const GITHUB_PAT_KEY = "github_pat";
    ${scanFunction}
    return syncProjectById;
  `)(indexSourceDocsFromDisk, OwnershipAdmissionError);
  const cases = [];
  for (const input of inputs) {
    const directory = mkdtempSync(join(tmpdir(), "pp-source-scan-probe-"));
    try {
      for (const [path, content] of Object.entries(input.files)) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), content);
      }
      let rows;
      const result = indexSourceDocsFromDisk({ replaceSourceDocs: (_id, found) => { rows = found; } }, 7, directory);
      rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      const documents = rows.map((row) => ({
        relative_path: row.path,
        kind: row.kind === "md" ? "markdown" : row.kind,
        size_bytes: row.sizeBytes,
        content_sha256: createHash("sha256").update(readFileSync(join(directory, row.path))).digest("hex"),
      }));
      const digest = (records) => createHash("sha256").update(records.map((record) => `${JSON.stringify(record)}\n`).join("")).digest("hex");
      const inventory_digest = digest(documents);
      const index_digest = digest(rows.map((row, index) => [row.path, row.kind, row.sizeBytes,
        documents[index].content_sha256, row.extractStatus, row.pageCount, null, null]));
      const completion = await syncProjectById({
        getProjectRow: () => ({ sourceKind: "local", localPath: directory, lastCommitSha: null }),
        getSourceActivationObservation: () => ({ id: 7 }), getSetting: () => null,
        replaceSourceDocs: () => {}, markSourceSynced: () => {},
      }, directory, 7, directory, { beforePublish: () => {}, maxDocsBytes: 1024 });
      cases.push({ id: input.id, documents, rows, result, inventory_digest, index_digest, completion });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const { SqliteDatabase, getDb } = await import(pathToFileURL(join(root, "web/apps/server/src/db/client.ts")).href);
  const { AppRepository } = await import(pathToFileURL(join(root, "web/apps/server/src/db/repository.ts")).href);
  const { default: Database } = await import(pathToFileURL(join(root, "web/node_modules/better-sqlite3/lib/index.js")).href);
  const failures = [];
  const directory = mkdtempSync(join(tmpdir(), "pp-source-scan-failure-"));
  const database = new SqliteDatabase(directory);
  let raw;
  try {
    database.connect();
    raw = new Database(database.dbPath);
    const repo = new AppRepository(getDb(database), "default", database.reposDir);
    const source = repo.createSource({ name: "Failure", source_kind: "local", source_type: "local" });
    repo.markSourceSynced = () => { throw new Error("disk read failed"); };
    for (const [id, metadata] of [
      ["sql-null", null],
      ["object", '{"keep":7,"sync_error":"old","sync_required":false}'],
      ["empty-string", ""],
      ["malformed", "{broken"],
      ["array", '[1,"two",null]'],
      ["json-string", '"hello"'],
      ["number", "42"],
      ["boolean", "false"],
      ["json-null", "null"],
      ["whitespace", "  "],
      ["overflow-object", '{"keep":7,"x":1e400,"nested":[-1e400,{"x":1e400}]}'],
      ["rounded-integer", '{"x":9007199254740993}'],
      ["category", '{"category":" Printers / Frame "}'],
      ["empty-category", '{"category":" / / "}'],
      ["nonstring-category", '{"category":7}'],
      ["lone-high-surrogate", String.raw`{"keep":7,"x":"\ud800"}`],
      ["lone-low-surrogate", String.raw`{"x":"\udc00","\udc00":"key"}`],
      ["surrogate-pairs", String.raw`{"reversed":"\ude00\ud83d","pair":"\ud83d\ude00","category":" a / \ud800 / "}`],
      ["key-order", '{"b":1,"10":2,"2":3,"b":4,"sync_error":"old","01":5,"4294967295":6}'],
    ]) {
      raw.prepare("UPDATE projects SET metadata_json=? WHERE id=?").run(metadata, source.id);
      let error;
      try {
        await syncProjectById(repo, directory, source.id, directory, { beforePublish: () => {}, maxDocsBytes: 1024 });
      } catch (caught) { error = caught.message; }
      const stored = raw.prepare("SELECT metadata_json FROM projects WHERE id=?").get(source.id).metadata_json;
      failures.push({ id, metadata, detail: "disk read failed", stored, error });
    }
  } finally {
    raw?.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({ cases, failures }));
} else {
  const probe = execFileSync(process.execPath, [
    "--conditions=development", "--import", pathToFileURL(join(root, "web/node_modules/tsx/dist/esm/index.mjs")).href,
    fileURLToPath(import.meta.url), "--probe",
  ], { cwd: join(root, "web/apps/server"), encoding: "utf8" });
  const { cases, failures } = JSON.parse(probe);
  const text = `${JSON.stringify({ generated: "@generated by fixtures/parity/source-scan/generate.mjs. Do not edit.", source, cases, failures }, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== text) throw new Error("source-scan.json is out of date");
  } else {
    writeFileSync(output, text);
  }
  console.log(JSON.stringify({ cases: cases.length, failures: failures.length, check: process.argv.includes("--check") }));
}
