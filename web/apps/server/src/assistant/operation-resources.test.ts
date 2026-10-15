import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import * as schema from "../db/schema.js";
import { tenantStorage } from "../middleware/tenant-context.js";
import { ISOLATED_SOURCE_FILESYSTEM } from "../services/source-filesystem-policy.js";
import { digestEffectiveNaming } from "../services/plan-freshness.js";
import { createJobRunner } from "../services/job-runner.js";
import { WORKFLOW_GUIDE } from "../routes/workflow-guide.js";
import { invokeAssistantTool } from "./tools.js";

const observer = vi.hoisted(() => {
  type Access = { api: string; args: unknown[]; result?: unknown };
  const state: { active: boolean; files: Access[] } = { active: false, files: [] };
  function wrap(module: object, prefix = ""): object {
    return Object.fromEntries(Object.entries(module).map(([name, value]) => {
      if (name === "default" || name === "promises") return [name, wrap(value, prefix + (name === "promises" ? "promises." : ""))];
      if (typeof value !== "function") return [name, value];
      return [name, new Proxy(value, {
        apply(target, receiver, args: unknown[]) {
          const access: Access = { api: prefix + name, args };
          if (state.active) state.files.push(access);
          const result: unknown = Reflect.apply(target, receiver, args);
          access.result = result;
          return result;
        },
        get(target, property, receiver) {
          const member: unknown = Reflect.get(target, property, receiver);
          if (typeof member !== "function") return member;
          return (...args: unknown[]) => {
            if (state.active) state.files.push({ api: `${prefix}${name}.${String(property)}`, args });
            return Reflect.apply(member, target, args);
          };
        },
      })];
    }));
  }
  return { state, wrap };
});
vi.mock("node:fs", async (original) => observer.wrap(await original<object>()));
vi.mock("node:fs/promises", async (original) => observer.wrap(await original<object>(), "promises."));

const TOOL_IDS = ["read_source_file", "list_sources", "list_source_categories"] as const;
const TABLES = ["table:app_settings", "table:projects", "table:source_docs"];
const FILE_RESOURCES = ["file:source-workspace", "table:projects", "table:source_docs"];
const manifest = z.object({ resources: z.object({ reviewed: z.array(z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("source.sync"), import: z.literal("source.sync") }).strict(),
  z.object({ operation: z.enum(["tool.read_source_file", "tool.list_sources", "tool.list_source_categories", "tool.search_source_files", "tool.preview_source_naming", "tool.get_workflow_help", "tool.get_plan_decisions", "tool.list_plans", "tool.get_job_status", "tool.list_plan_snapshots", "tool.ui_highlight_part", "tool.ui_focus_stl_search", "tool.ui_navigate", "tool.ui_open_source", "tool.ui_open_docs"]),
    resources: z.array(z.object({ kind: z.enum(["table", "file"]), name: z.string() }).strict()),
  }).strict(),
])) }) }).parse(JSON.parse(fs.readFileSync(new URL("../../../../../rust/crates/pp-gateway/ownership-manifest.json", import.meta.url), "utf8")));

function tableForObservedSelect(statement: unknown, tenantId = "default"): string {
  const sql = z.string().parse(statement);
  const literal = "'(?:[^']|'')*'";
  const activeTenant = `'${tenantId.replaceAll("'", "''")}'`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const columns = '"[a-z_]+"(?:, "[a-z_]+")*';
  const tenant = `"projects"\\."tenant_id" = ${activeTenant}`;
  const shapes: [string, RegExp][] = [
    ["projects", new RegExp(`^select ${columns} from "projects" where ${tenant} order by "projects"\\."name" asc$`)],
    ["projects", new RegExp(`^select ${columns} from "projects" where \\(${tenant} and "projects"\\."id" = -?(?:0|[1-9][0-9]*)(?:\\.0)?\\)$`)],
    ["source_docs", new RegExp(`^select "project_id", count\\(\\*\\) from "source_docs" where "source_docs"\\."tenant_id" = ${activeTenant} group by "source_docs"\\."project_id"$`)],
    ["app_settings", new RegExp(`^select ${columns} from "app_settings" where \\("app_settings"\\."tenant_id" = ${activeTenant} and "app_settings"\\."key" = ${literal}\\)$`)],
    ["build_profiles", new RegExp(`^select "id", "name", "order_number", "archived_at" from "build_profiles" where \\("build_profiles"\\."tenant_id" = ${activeTenant} and "build_profiles"\\."id" = -?(?:0|[1-9][0-9]*)(?:\\.0)?\\)$`)],
    ["plan_decisions", new RegExp(`^select ${columns} from "plan_decisions" where \\("plan_decisions"\\."tenant_id" = ${activeTenant} and "plan_decisions"\\."profile_id" = -?(?:0|[1-9][0-9]*)(?:\\.0)?\\) order by "plan_decisions"\\."created_at" asc$`)],
  ];
  const match = shapes.find(([, pattern]) => pattern.test(sql));
  if (!match) throw new Error(`Unsupported SQL: ${sql}`);
  return `table:${match[0]}`;
}

function under(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function fileResources(roots: string[], traversal = false): string[] {
  const descriptors = new Map<number, string>();
  const resources = new Set<string>();
  for (const { api, args, result } of observer.state.files) {
    expect(["realpathSync", "existsSync", "statSync", "openSync", "readSync", "closeSync", ...(traversal ? ["readdirSync", "lstatSync"] : [])], `Unsupported filesystem call ${api}`).toContain(api);
    if (api === "readdirSync") expect(args).toEqual([args[0], { withFileTypes: true }]);
    if (api === "lstatSync") expect(args).toEqual([args[0]]);
    const path = typeof args[0] === "number" ? descriptors.get(args[0]) : args[0];
    expect(typeof path, api).toBe("string");
    if (typeof path !== "string") throw new Error(`Unclassified path for ${api}`);
    expect(roots.some((root) => under(root, path)), `${api} ${path}`).toBe(true);
    const escapingCanonicalizationProbe = api === "realpathSync" && typeof result === "string" && !roots.some((root) => under(root, result));
    if (escapingCanonicalizationProbe) continue;
    resources.add("file:source-workspace");
    if (api === "openSync") {
      expect(args[1]).toBe("r");
      if (typeof result === "number") descriptors.set(result, path);
    }
    if (api === "closeSync" && typeof args[0] === "number") descriptors.delete(args[0]);
  }
  expect(descriptors.size).toBe(0);
  return [...resources];
}

let dataDir: string;
let userRoot: string;
let root: string;
let sqlite: Database.Database;
let repo: AppRepository;
let sourceId: number;
let userId: number;
let unsyncedId: number;
let statements: unknown[];
let unions: Map<string, Set<string>>;
beforeEach(() => {
  dataDir = fs.mkdtempSync(join(tmpdir(), "gre402-data-"));
  userRoot = fs.mkdtempSync(join(tmpdir(), "gre402-user-local-"));
  const setup = new SqliteDatabase(dataDir);
  setup.connect();
  setup.close();
  statements = [];
  unions = new Map();
  sqlite = new Database(join(dataDir, "print-partner.db"), { verbose: (sql) => { if (observer.state.active) statements.push(sql); } });
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  repo = new AppRepository(db, undefined, join(dataDir, "repos"));
  root = join(dataDir, "sources", "fixture");
  fs.mkdirSync(root, { recursive: true });
  sourceId = repo.createSource({ name: "Fixture", source_kind: "local", local_path: root, metadata: { category: "Printers/Core" } }).id;
  userId = repo.createSource({ name: "UserLocal", source_kind: "local", local_path: userRoot }).id;
  unsyncedId = repo.createSource({ name: "Unsynced", source_kind: "local" }).id;
  for (const id of [sourceId, userId]) repo.updateSource(id, { last_synced_at: "2026-01-01T00:00:00Z" });
  repo.saveSourceCategories(["Printers", "Printers/Core"]);
  db.insert(schema.sourceDocs).values({ projectId: sourceId, path: "README.md", kind: "markdown", updatedAt: "2026-01-01" }).run();
  fs.writeFileSync(join(root, "README.md"), "Actual fixture text\n");
  fs.writeFileSync(join(userRoot, "README.md"), "User-local text\n");
  fs.writeFileSync(join(root, "binary.txt"), Buffer.from([65, 0, 66]));
  fs.writeFileSync(join(root, "large.txt"), "x".repeat(102401));
  fs.mkdirSync(join(root, "directory"));
  fs.symlinkSync(join(root, "README.md"), join(root, "inside.md"));
  fs.writeFileSync(join(dataDir, "outside.txt"), "Must not read");
  fs.symlinkSync(join(dataDir, "outside.txt"), join(root, "escape.md"));
});
afterEach(() => {
  observer.state.active = false;
  sqlite?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(userRoot, { recursive: true, force: true });
});

async function invoke(tool: typeof TOOL_IDS[number] | "search_source_files" | "preview_source_naming", input: Record<string, unknown>, expected: string[], tenantId = "default") {
  statements = [];
  observer.state.files = [];
  observer.state.active = true;
  let result: Awaited<ReturnType<typeof invokeAssistantTool>>;
  try { result = await tenantStorage.run(tenantId, () => invokeAssistantTool(tool, input, { repo })); }
  finally { observer.state.active = false; }
  const roots = [root, userRoot];
  if (tool === "search_source_files") roots.push(join(dataDir, "repos", String(unsyncedId)));
  const observed = [...new Set([...statements.map((sql) => tableForObservedSelect(sql, tenantId)), ...fileResources(roots, tool === "search_source_files")])].sort();
  expect(observed).toEqual(expected);
  if (tool === "search_source_files") {
    expect(observer.state.files.every(({ api }) => ["existsSync", "readdirSync", "lstatSync", "statSync"].includes(api))).toBe(true);
  }
  const union = unions.get(tool) ?? new Set<string>();
  for (const resource of observed) union.add(resource);
  unions.set(tool, union);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(result.content));
}

it("traces all three pinned tools against independent unions and the admitted declarations", async () => {
  for (const source of [String(sourceId), "fixture", String(userId)]) {
    const output = await invoke("read_source_file", { source, path: "README.md" }, FILE_RESOURCES);
    expect(output.text).toBe(source === String(userId) ? "User-local text\n" : "Actual fixture text\n");
    expect(observer.state.files.map(({ api }) => api)).toEqual(["realpathSync", "realpathSync", "statSync", "existsSync", "statSync", "openSync", "readSync", "closeSync"]);
  }
  expect((await invoke("read_source_file", { source: "Fixture", path: "inside.md" }, FILE_RESOURCES)).text).toBe("Actual fixture text\n");
  for (const path of ["escape.md", "absent.md", "directory"]) {
    expect((await invoke("read_source_file", { source: "Fixture", path }, FILE_RESOURCES)).error).toBe("Invalid path (path traversal rejected)");
    expect(observer.state.files.filter(({ api }) => api === "openSync" || api === "readSync")).toEqual([]);
  }
  const tables = ["table:projects", "table:source_docs"];
  expect((await invoke("read_source_file", { source: "Fixture", path: "../outside.txt" }, tables)).error).toBe("Invalid path (path traversal rejected)");
  expect((await invoke("read_source_file", { source: "Fixture", path: "part.stl" }, tables)).error).toBe("Refusing binary path extension: part.stl");
  expect((await invoke("read_source_file", { source: "Fixture", path: "binary.txt" }, FILE_RESOURCES)).error).toBe("Refusing binary file (null bytes detected)");
  const large = await invoke("read_source_file", { source: "Fixture", path: "large.txt" }, FILE_RESOURCES);
  expect(large.text).toBe("x".repeat(102400));
  expect(large.truncated).toBe(true);
  expect((await invoke("read_source_file", { source: String(unsyncedId), path: "README.md" }, tables)).error).toBe('Source "Unsynced" is not synced locally.');
  for (const source of ["999999", "Fixtare"]) {
    expect((await invoke("read_source_file", { source, path: "README.md" }, tables)).error).toBe(
      source === "999999" ? 'Source not found: "999999". Call list_sources first.' : 'Source not found: "Fixtare". Did you mean: "Fixture"? Call list_sources first.',
    );
  }
  expect((await invoke("read_source_file", {}, [])).error).toBe("source and path required");
  const sourceRows = z.array(z.object({ name: z.string(), doc_count: z.number() }));
  expect(sourceRows.parse((await invoke("list_sources", {}, tables)).sources)).toEqual([
    { name: "Fixture", doc_count: 1 }, { name: "Unsynced", doc_count: 0 }, { name: "UserLocal", doc_count: 0 },
  ]);
  for (const [input, names] of [
    [{ category: "Printers" }, ["Fixture"]],
    [{ category: "Printers", include_subcategories: false }, []],
    [{ category: "Printers/Core" }, ["Fixture"]],
    [{ category: "__uncategorized__" }, ["Unsynced", "UserLocal"]],
  ] satisfies [Record<string, unknown>, string[]][]) {
    const output = await invoke("list_sources", input, input.category === "__uncategorized__" ? tables : TABLES);
    expect(sourceRows.parse(output.sources).map((row) => row.name)).toEqual(names);
    expect(observer.state.files).toEqual([]);
  }
  expect((await invoke("list_sources", { category: "Missing" }, ["table:app_settings"])).error).toBe('Unknown library category: "Missing". Call list_source_categories, or create it with propose_create_source_category.');
  const categories = await invoke("list_source_categories", {}, TABLES);
  expect(categories.categories).toEqual([
    { path: "Printers", name: "Printers", parent: null, depth: 0, sources: 0, sources_including_subcategories: 1 },
    { path: "Printers/Core", name: "Core", parent: "Printers", depth: 1, sources: 1, sources_including_subcategories: 1 },
  ]);
  expect(categories.uncategorized_sources).toBe(2);
  expect(observer.state.files).toEqual([]);
  expect([...unions.keys()].sort()).toEqual([...TOOL_IDS].sort());
  const reviewed = manifest.resources.reviewed
    .filter((entry) => entry.operation !== "source.sync")
    .filter((entry) => TOOL_IDS.some((id) => entry.operation === `tool.${id}`));
  expect(reviewed.map((entry) => entry.operation).sort()).toEqual(TOOL_IDS.map((id) => `tool.${id}`).sort());
  for (const entry of reviewed) {
    expect([...unions.get(entry.operation.slice(5)) ?? []].sort()).toEqual(entry.resources.map(({ kind, name }) => `${kind}:${name}`).sort());
  }
  sqlite.exec("DELETE FROM source_docs; DELETE FROM projects; DELETE FROM app_settings WHERE key = 'source_categories'");
  const empty = await invoke("list_source_categories", {}, TABLES);
  expect(z.array(z.object({ path: z.string(), sources: z.number(), sources_including_subcategories: z.number() })).parse(empty.categories)).toEqual(
    ["Printer kits", "Toolheads", "Probes & sensors", "Mods", "Hardware", "Other"].map((path) => ({ path, sources: 0, sources_including_subcategories: 0 })),
  );
  expect(empty.uncategorized_sources).toBe(0);
});

it("traces search_source_files against an independent union with trusted real roots", async () => {
  const tables = ["table:projects", "table:source_docs"];
  const error = "source_id or source_name required";
  const files = [{ path: "Needle.txt", byte_size: 4 }, { path: "nested/needle.bin", byte_size: 3 }];
  fs.writeFileSync(join(root, "Needle.txt"), "four");
  fs.mkdirSync(join(root, "nested"));
  fs.writeFileSync(join(root, "nested", "needle.bin"), Buffer.from([65, 0, 66]));
  for (const directory of [".git", "node_modules", ".docs-text"]) {
    fs.mkdirSync(join(root, directory));
    fs.writeFileSync(join(root, directory, "needle.txt"), "excluded");
  }
  for (const [target, name] of [
    [join(root, "Needle.txt"), "needle-inside-file"],
    [join(dataDir, "outside.txt"), "needle-outside-file"],
    [join(root, "nested"), "needle-inside-dir"],
    [userRoot, "needle-outside-dir"],
  ]) fs.symlinkSync(target, join(root, name));
  for (const selector of [{ source_id: sourceId }, { source_name: " fixture " }, { source_id: String(sourceId), source_name: "UserLocal" }]) {
    expect(await invoke("search_source_files", { ...selector, query: " NEEDLE " }, FILE_RESOURCES)).toEqual({
      source: { id: sourceId, name: "Fixture", last_commit_sha: null }, query: "needle", files, total_matches: 2, truncated: false,
    });
    const accesses = observer.state.files;
    expect(accesses[0]).toEqual({ api: "existsSync", args: [root], result: true });
    expect(accesses.filter(({ api }) => api === "readdirSync").map(({ args }) => args[0]).sort()).toEqual([
      root, join(root, "directory"), join(root, "nested"),
    ].sort());
    for (const directory of [".git", "node_modules", ".docs-text"]) {
      expect(accesses.some(({ args }) => args[0] === join(root, directory))).toBe(false);
    }
    for (const name of ["needle-inside-file", "needle-outside-file", "needle-inside-dir", "needle-outside-dir"]) {
      expect(accesses.filter(({ args }) => args[0] === join(root, name)).map(({ api }) => api)).toEqual(["lstatSync"]);
    }
  }
  for (const input of [{}, { source_name: " " }, { source_id: "invalid" }, { source_id: null }]) {
    expect(await invoke("search_source_files", { ...input, query: "needle" }, [])).toEqual({ error });
  }
  for (const source_id of [999999, 0, -1]) {
    expect(await invoke("search_source_files", { source_id, source_name: "Fixture", query: "needle" }, ["table:projects"])).toEqual({ error });
  }
  expect(await invoke("search_source_files", { source_name: "Missing", query: "needle" }, tables)).toEqual({ error });
  expect(await invoke("search_source_files", { source_id: unsyncedId, query: "" }, FILE_RESOURCES)).toEqual({ error: "Source is not synchronized" });
  expect(observer.state.files).toEqual([{ api: "existsSync", args: [join(dataDir, "repos", String(unsyncedId))], result: false }]);
  sqlite.prepare("UPDATE projects SET local_path = NULL WHERE id = ?").run(unsyncedId);
  expect(await invoke("search_source_files", { source_id: unsyncedId, query: "" }, tables)).toEqual({ error: "Source is not synchronized" });
  expect(observer.state.files).toEqual([]);
  const missingId = repo.createSource({ name: "MissingRoot", source_kind: "local", local_path: join(root, "missing") }).id;
  expect(await invoke("search_source_files", { source_id: missingId, query: "" }, FILE_RESOURCES)).toEqual({ error: "Source is not synchronized" });
  expect(observer.state.files).toEqual([{ api: "existsSync", args: [join(root, "missing")], result: false }]);
  for (const query of [undefined, "", " "]) {
    expect(await invoke("search_source_files", { source_id: sourceId, query }, FILE_RESOURCES)).toEqual({ error: "query required" });
    expect(observer.state.files).toEqual([{ api: "existsSync", args: [root], result: true }]);
  }
  expect(await invoke("search_source_files", { source_id: sourceId, query: "no-matches" }, FILE_RESOURCES)).toEqual({
    source: { id: sourceId, name: "Fixture", last_commit_sha: null }, query: "no-matches", files: [], total_matches: 0, truncated: false,
  });
  expect((await invoke("search_source_files", { source_id: userId, query: "readme" }, FILE_RESOURCES)).files).toEqual([{ path: "README.md", byte_size: 16 }]);
  const fileId = repo.createSource({ name: "FileRoot", source_kind: "local", local_path: join(root, "README.md") }).id;
  expect(await invoke("search_source_files", { source_id: fileId, query: "readme" }, FILE_RESOURCES)).toEqual({
    source: { id: fileId, name: "FileRoot", last_commit_sha: null }, query: "readme", files: [], total_matches: 0, truncated: false,
  });
  expect(observer.state.files.map(({ api }) => api)).toEqual(["existsSync", "readdirSync"]);

  const limitRoot = join(root, "limits");
  fs.mkdirSync(limitRoot);
  const matches = Array.from({ length: 205 }, (_, index) => ({ path: `match-${String(index).padStart(3, "0")}.txt`, byte_size: 1 }));
  for (const file of matches) fs.writeFileSync(join(limitRoot, file.path), "x");
  const limitId = repo.createSource({ name: "Limits", source_kind: "local", local_path: limitRoot }).id;
  for (const [limit, count] of [[undefined, 50], [0, 1], [-9, 1], [2, 2], [999, 200]] satisfies [number | undefined, number][]) {
    expect(await invoke("search_source_files", { source_id: limitId, query: "match", limit }, FILE_RESOURCES)).toEqual({
      source: { id: limitId, name: "Limits", last_commit_sha: null }, query: "match",
      files: matches.slice(0, count), total_matches: 205, truncated: true,
    });
    expect(observer.state.files.filter(({ api }) => api === "statSync").length).toBe(205);
    expect(observer.state.files.filter(({ api }) => api === "lstatSync").length).toBe(205);
  }

  fs.symlinkSync(userRoot, join(root, "root-link"));
  fs.mkdirSync(join(userRoot, "ancestor"));
  fs.writeFileSync(join(userRoot, "ancestor", "README.md"), "ancestor");
  for (const [path, expected] of [
    [join(root, "root-link"), [{ path: "ancestor/README.md", byte_size: 8 }, { path: "README.md", byte_size: 16 }]],
    [join(root, "root-link", "ancestor"), [{ path: "README.md", byte_size: 8 }]],
  ] satisfies [string, { path: string; byte_size: number }[]][]) {
    const id = repo.createSource({ name: path, source_kind: "local", local_path: path }).id;
    expect((await invoke("search_source_files", { source_id: id, query: "readme" }, FILE_RESOURCES)).files).toEqual(expected);
  }

  const otherId = tenantStorage.run("other", () => repo.createSource({ name: "Fixture", source_kind: "local", local_path: userRoot }).id);
  for (const tenantId of ["default", "other"]) {
    const output = await invoke("search_source_files", { source_name: "Fixture", query: "readme" }, FILE_RESOURCES, tenantId);
    expect(output.source).toEqual({ id: tenantId === "default" ? sourceId : otherId, name: "Fixture", last_commit_sha: null });
    expect(output.files).toEqual(tenantId === "default" ? [{ path: "README.md", byte_size: 20 }] : [
      { path: "ancestor/README.md", byte_size: 8 }, { path: "README.md", byte_size: 16 },
    ]);
  }
  expect(await invoke("search_source_files", { source_id: sourceId, source_name: "Fixture", query: "readme" }, ["table:projects"], "other")).toEqual({ error });
  expect((await invoke("search_source_files", { source_id: otherId, query: "readme" }, FILE_RESOURCES, "other")).source).toEqual({ id: otherId, name: "Fixture", last_commit_sha: null });
  expect([...unions.get("search_source_files") ?? []].sort()).toEqual(["file:source-workspace", "table:projects", "table:source_docs"]);
  const declaration = manifest.resources.reviewed.find((entry) => entry.operation === "tool.search_source_files");
  if (!declaration || declaration.operation === "source.sync") throw new Error("Missing search declaration");
  expect(declaration.resources.map(({ kind, name }) => `${kind}:${name}`).sort()).toEqual(["file:source-workspace", "table:projects", "table:source_docs"]);
});

it("rejects unsupported SQL shapes and filesystem calls after recording", async () => {
  for (const sql of [
    'select * from "projects" join "source_docs" on 1=1',
    'select (select name from projects) from "projects"',
    'select "id" from "unknown"', 'delete from "projects"',
    'select "id" from "projects"; select "id" from "source_docs"',
    'select "id" from "projects" where "projects"."tenant_id" = \'default\' order by "projects"."name" asc -- ignored',
    'select "id" from "projects" as "source_docs"',
    'select "id" from "projects" where "projects"."tenant_id" = \'other\' order by "projects"."name" asc',
  ]) expect(() => tableForObservedSelect(sql)).toThrow(`Unsupported SQL: ${sql}`);
  for (const [api, read] of [
    ["readFileSync", () => fs.readFileSync(join(root, "README.md"), "utf8")],
    ["promises.readFile", () => fs.promises.readFile(join(root, "README.md"), "utf8")],
    ["promises.readFile", () => readFile(join(root, "README.md"), "utf8")],
  ] satisfies [string, () => string | Promise<string>][]) {
    observer.state.files = [];
    observer.state.active = true;
    const text = await read();
    observer.state.active = false;
    expect(text).toBe("Actual fixture text\n");
    expect(() => fileResources([root])).toThrow(`Unsupported filesystem call ${api}`);
  }
  for (const [api, read] of [
    ["readFileSync", () => fs.readFileSync(join(root, "absent.md"), "utf8")],
    ["promises.readFile", () => fs.promises.readFile(join(root, "absent.md"), "utf8")],
  ] satisfies [string, () => string | Promise<string>][]) {
    observer.state.files = [];
    observer.state.active = true;
    try { await expect(Promise.resolve().then(read)).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { observer.state.active = false; }
    expect(observer.state.files.map(({ api }) => api)).toEqual([api]);
    expect(() => fileResources([root])).toThrow("Unsupported filesystem call");
  }
  observer.state.active = true;
  sqlite.exec("UPDATE projects SET name = name");
  observer.state.active = false;
  expect(() => statements.map((sql) => tableForObservedSelect(sql))).toThrow("Unsupported SQL: UPDATE projects SET name = name");
});


it("traces preview_source_naming reads, fallbacks and tenant settings against its exact union", async () => {
  const namingTables = ["table:app_settings", "table:projects"];
  const paths = ["parts/[a]_bracket_x4.stl", "widget_qty3.stl"];
  const previews = z.array(z.object({ path: z.string(), quantity: z.number(), role: z.string() }));
  const preview = async (input: Record<string, unknown>, expected: string[], tenantId = "default") => {
    const output = await invoke("preview_source_naming", input, expected, tenantId);
    expect(observer.state.files).toEqual([]);
    return output;
  };
  for (const input of [{}, { paths: [] }, { paths: "part.stl" }]) {
    expect(await preview(input, [])).toEqual({ error: "paths required" });
  }
  expect(previews.parse((await preview({ paths }, ["table:app_settings"])).results)).toEqual([
    { path: paths[0], quantity: 4, role: "accent" },
    { path: paths[1], quantity: 1, role: "primary" },
  ]);
  for (const source_id of [sourceId, String(sourceId), 999999, 0, -1]) {
    const output = await preview({ paths, source_id }, namingTables);
    expect(previews.parse(output.results).map(({ quantity }) => quantity)).toEqual([4, 1]);
  }
  expect((await preview({ paths: [null, 42, {}], source_id: sourceId }, namingTables)).results).toEqual([]);
  expect(previews.parse((await preview({ paths, source_id: "invalid" }, ["table:app_settings"])).results).map(({ quantity }) => quantity)).toEqual([4, 1]);

  repo.setSetting("stl_naming_defaults", JSON.stringify({ ...repo.getGlobalNaming(), quantity: { regex: String.raw`_qty([0-9]+)\.stl$`, default: 2 } }));
  expect(previews.parse((await preview({ paths, source_id: sourceId }, namingTables)).results).map(({ quantity }) => quantity)).toEqual([2, 3]);
  repo.updateSource(sourceId, { metadata: { naming: { use_defaults: false, override: { quantity: { default: 7 } } } } });
  expect(previews.parse((await preview({ paths, source_id: sourceId }, namingTables)).results).map(({ quantity }) => quantity)).toEqual([7, 3]);
  expect(previews.parse((await preview({ paths, source_id: sourceId, profile: { quantity: { default: 9 } } }, namingTables)).results).map(({ quantity }) => quantity)).toEqual([9, 3]);
  expect(await preview({ paths, source_id: sourceId, profile: { quantity: { regex: "[" } } }, namingTables)).toHaveProperty("error", expect.stringMatching(/invalid/i));

  repo.updateSource(sourceId, { metadata: { naming: { use_defaults: "invalid" } } });
  expect(previews.parse((await preview({ paths, source_id: sourceId }, namingTables)).results).map(({ quantity }) => quantity)).toEqual([2, 3]);
  repo.setSetting("stl_naming_defaults", "not-json");
  expect(previews.parse((await preview({ paths, source_id: sourceId }, namingTables)).results).map(({ quantity }) => quantity)).toEqual([4, 1]);

  await tenantStorage.run("tenant-b", async () => {
    repo.setSetting("stl_naming_defaults", JSON.stringify({ ...repo.getGlobalNaming(), quantity: { regex: String.raw`_qty([0-9]+)\.stl$`, default: 11 } }));
    const ownSource = repo.createSource({ name: "Tenant B", source_kind: "local" });
    expect(previews.parse((await preview({ paths, source_id: ownSource.id }, namingTables, "tenant-b")).results).map(({ quantity }) => quantity)).toEqual([11, 3]);
    expect(previews.parse((await preview({ paths, source_id: sourceId }, namingTables, "tenant-b")).results).map(({ quantity }) => quantity)).toEqual([11, 3]);
  });
  expect(previews.parse((await preview({ paths, source_id: sourceId }, namingTables)).results).map(({ quantity }) => quantity)).toEqual([4, 1]);
  expect([...unions.get("preview_source_naming") ?? []].sort()).toEqual(namingTables);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.preview_source_naming");
  if (!entry || entry.operation === "source.sync") throw new Error("Missing naming declaration");
  expect(entry.resources.map(({ kind, name }) => `${kind}:${name}`).sort()).toEqual(namingTables);
});


it("traces get_workflow_help as an explicitly resource-free operation", async () => {
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.get_workflow_help");
  if (!entry || entry.operation === "source.sync") throw new Error("Missing workflow help declaration");
  expect(entry.resources).toEqual([]);
  const expected = WORKFLOW_GUIDE.length > 3500 ? `${WORKFLOW_GUIDE.slice(0, 3480)}\n…[truncated]` : WORKFLOW_GUIDE;
  for (const tenantId of ["default", "tenant-b"]) {
    for (const input of [{}, { source_id: sourceId, plan_id: 999999, query: "ignored" }]) {
      statements = [];
      observer.state.files = [];
      observer.state.active = true;
      let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
      try { output = await tenantStorage.run(tenantId, () => invokeAssistantTool("get_workflow_help", input, { repo })); }
      finally { observer.state.active = false; }
      expect(output.content).toBe(expected);
      expect(output.content).toContain("# Print Partner workflow");
      expect(output.content.length).toBeLessThanOrEqual(3500);
      expect(statements).toEqual([]);
      expect(observer.state.files).toEqual([]);
    }
  }
});

it("rejects an undeclared read against the empty get_workflow_help resource set", async () => {
  statements = [];
  observer.state.files = [];
  observer.state.active = true;
  try {
    await invokeAssistantTool("get_workflow_help", {}, { repo });
    repo.listSources();
  } finally { observer.state.active = false; }
  const observed = [...new Set(statements.map((sql) => tableForObservedSelect(sql)))].sort();
  expect(observed).toEqual(["table:projects", "table:source_docs"]);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.get_workflow_help");
  if (!entry || entry.operation === "source.sync") throw new Error("Missing workflow help declaration");
  const declared = entry.resources.map(({ kind, name }) => `${kind}:${name}`).sort();
  expect(() => expect(observed).toEqual(declared)).toThrow();
});

it("traces get_plan_decisions plan lookup, limits, fallback and tenant isolation against its declaration", async () => {
  const planId = repo.createProfile("Decision plan").id;
  const emptyPlanId = repo.createProfile("Empty plan").id;
  const first = repo.createPlanDecision({ planId, actor: "assistant", kind: "applied_action", summary: "First decision" });
  const last = repo.createPlanDecision({ planId, actor: "user", kind: "dismissed_action", summary: "Last decision" });
  sqlite.prepare("UPDATE plan_decisions SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00Z", first.id);
  sqlite.prepare("UPDATE plan_decisions SET created_at = ? WHERE id = ?").run("2026-01-02T00:00:00Z", last.id);
  const foreignPlanId = tenantStorage.run("tenant-b", () => repo.createProfile("Other tenant plan").id);
  const foreign = tenantStorage.run("tenant-b", () => repo.createPlanDecision({ planId: foreignPlanId, actor: "user", kind: "dismissed_action", summary: "Private decision" }));
  const union = new Set<string>();
  async function trace(input: Record<string, unknown>, expected: string[], tenantId = "default", activePlanId?: number) {
    statements = [];
    observer.state.files = [];
    observer.state.active = true;
    let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
    try { output = await tenantStorage.run(tenantId, () => invokeAssistantTool("get_plan_decisions", input, { repo, activePlanId })); }
    finally { observer.state.active = false; }
    const observed = [...new Set(statements.map((sql) => tableForObservedSelect(sql, tenantId)))].sort();
    expect(observed).toEqual(expected);
    expect(observer.state.files).toEqual([]);
    for (const resource of observed) union.add(resource);
    return z.object({ plan_id: z.number().optional(), error: z.string().optional(), decisions: z.array(z.object({ id: z.number(), summary: z.string() })).optional() }).parse(JSON.parse(output.content));
  }
  const tables = ["table:build_profiles", "table:plan_decisions"];
  expect(await trace({ plan_id: planId }, tables)).toMatchObject({ plan_id: planId, decisions: [{ id: first.id, summary: "First decision" }, { id: last.id, summary: "Last decision" }] });
  for (const limit of [1, "1", 0, -2]) {
    expect((await trace({ plan_id: String(planId), limit }, tables)).decisions).toEqual([{ id: last.id, summary: "Last decision" }]);
  }
  expect((await trace({ plan_id: emptyPlanId }, tables)).decisions).toEqual([]);
  for (const input of [{}, { plan_id: "invalid" }]) {
    expect(await trace(input, [])).toEqual({ error: "plan_id required" });
    expect((await trace(input, ["table:plan_decisions"], "default", planId)).decisions).toHaveLength(2);
  }
  for (const plan_id of [999999, foreignPlanId, 0, -1]) {
    expect(await trace({ plan_id }, ["table:build_profiles"])).toEqual({ error: "plan_id required" });
    expect((await trace({ plan_id }, tables, "default", planId)).decisions).toHaveLength(2);
  }
  expect((await trace({ plan_id: foreignPlanId }, tables, "tenant-b")).decisions).toEqual([{ id: foreign.id, summary: "Private decision" }]);
  expect(await trace({ plan_id: planId }, ["table:build_profiles"], "tenant-b")).toEqual({ error: "plan_id required" });
  expect((await trace({}, ["table:plan_decisions"], "tenant-b", planId)).decisions).toEqual([]);
  expect([...union].sort()).toEqual(tables);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.get_plan_decisions");
  if (!entry || entry.operation === "source.sync") throw new Error("Missing plan decisions declaration");
  expect(entry.resources.map(({ kind, name }) => `${kind}:${name}`).sort()).toEqual([...union].sort());
});


it("traces list_plans headers, part counts, freshness and tenant isolation against its exact union", async () => {
  const tables = ["table:app_settings", "table:build_profiles", "table:parts", "table:plan_accepted_input_sets", "table:plan_revision_input_sets", "table:plan_revision_inputs", "table:profile_layers", "table:projects", "table:source_revisions"];
  const union = new Set<string>();
  async function trace(input: Record<string, unknown>, expected: string[], tenantId = "default") {
    statements = [];
    observer.state.files = [];
    observer.state.active = true;
    let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
    try { output = await tenantStorage.run(tenantId, () => invokeAssistantTool("list_plans", input, { repo })); }
    finally { observer.state.active = false; }
    const observed = [...new Set(statements.flatMap((sql) => resourcesForPlanSelect(sql, tenantId)))].sort();
    expect(observed).toEqual(expected);
    expect(observer.state.files).toEqual([]);
    for (const sql of statements) expect(() => resourcesForPlanSelect(sql, tenantId === "default" ? "other" : "default")).toThrow("Unsupported SQL:");
    for (const resource of observed) union.add(resource);
    return z.object({ plans: z.array(z.object({ id: z.number(), name: z.string(), part_count: z.number(), build_stale: z.boolean() }).strict()) }).strict().parse(JSON.parse(output.content));
  }
  const emptyTables = ["table:app_settings", "table:build_profiles", "table:parts"];
  expect(await trace({}, emptyTables)).toEqual({ plans: [] });
  const alpha = repo.createProfile("Alpha");
  const zeta = repo.createProfile("Zeta", sourceId);
  sqlite.prepare("UPDATE build_profiles SET archived_at = ? WHERE id = ?").run("2026-01-01", zeta.id);
  sqlite.prepare("INSERT INTO parts (tenant_id, profile_id, match_key, relative_path, filename, quantity_effective, included) VALUES (?, ?, ?, ?, ?, ?, ?)").run("default", zeta.id, "part.stl", "part.stl", "part.stl", 7, 0);
  const partialTables = ["table:app_settings", "table:build_profiles", "table:parts", "table:plan_accepted_input_sets", "table:profile_layers", "table:projects"];
  const rows = { plans: [{ id: alpha.id, name: "Alpha", part_count: 0, build_stale: false }, { id: zeta.id, name: "Zeta", part_count: 1, build_stale: false }] };
  for (const input of [{}, { plan_id: -1, source_id: "invalid", limit: 0, archived: false }]) {
    expect(await trace(input, partialTables)).toEqual(rows);
  }
  const revision = repo.recordSourceRevision({ sourceId, upstreamRevisionKey: "a", manifestDigest: "a".repeat(64), snapshotLocator: `${sourceId}/revisions/a`, syncedAt: "2026-01-01", completeness: "complete" });
  sqlite.prepare("UPDATE projects SET current_source_revision_id = ? WHERE id = ?").run(revision.id, sourceId);
  const inputSet = sqlite.prepare("INSERT INTO plan_revision_input_sets (tenant_id, profile_id, input_set_digest, expected_input_count, format_version, recorded_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("default", zeta.id, "fixture", 0, 2, "2026-01-01", "2026-01-01");
  sqlite.prepare("INSERT INTO plan_accepted_input_sets (tenant_id, profile_id, input_set_id, accepted_at) VALUES (?, ?, ?, ?)").run("default", zeta.id, Number(inputSet.lastInsertRowid), "2026-01-01");
  expect(await trace({}, tables)).toEqual({ plans: [{ id: alpha.id, name: "Alpha", part_count: 0, build_stale: false }, { id: zeta.id, name: "Zeta", part_count: 1, build_stale: true }] });
  sqlite.prepare("INSERT INTO plan_revision_inputs (tenant_id, input_set_id, source_id, source_layer, layer_order, tracking_kind, source_revision_id, manifest_digest, effective_naming_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("default", Number(inputSet.lastInsertRowid), sourceId, "base:Fixture", 0, "revision", revision.id, "a".repeat(64), digestEffectiveNaming(repo.getGlobalNaming()));
  sqlite.prepare("UPDATE plan_revision_input_sets SET expected_input_count = 1 WHERE id = ?").run(Number(inputSet.lastInsertRowid));
  sqlite.prepare("UPDATE build_profiles SET last_recomputed_at = ?, config_modified_at = ? WHERE id = ?").run("2026-01-02", "2026-01-01", zeta.id);
  expect(await trace({}, tables)).toEqual(rows);
  sqlite.prepare("UPDATE build_profiles SET config_modified_at = ? WHERE id = ?").run("2026-01-03", zeta.id);
  expect(await trace({}, tables)).toEqual({ plans: [{ id: alpha.id, name: "Alpha", part_count: 0, build_stale: false }, { id: zeta.id, name: "Zeta", part_count: 1, build_stale: true }] });
  expect(await trace({}, emptyTables, "other")).toEqual({ plans: [] });
  const other = tenantStorage.run("other", () => repo.createProfile("Other"));
  expect(await trace({ plan_id: zeta.id }, ["table:app_settings", "table:build_profiles", "table:parts", "table:plan_accepted_input_sets", "table:profile_layers"], "other")).toEqual({ plans: [{ id: other.id, name: "Other", part_count: 0, build_stale: false }] });
  expect([...union].sort()).toEqual(tables);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.list_plans");
  if (!entry || entry.operation === "source.sync") throw new Error("Missing list plans declaration");
  expect(entry.resources.map(({ kind, name }) => `${kind}:${name}`).sort()).toEqual(["file:source-workspace", ...tables]);
});

it("traces list_plans isolated workspace probes and refusals against its operation-wide union", async () => {
  const repos = join(dataDir, "repos");
  const workspace = join(repos, String(sourceId));
  const revisionRoot = join(workspace, "revisions", "a");
  fs.mkdirSync(revisionRoot, { recursive: true });
  const escape = join(workspace, "escape");
  fs.symlinkSync(userRoot, escape, "dir");
  const isolatedRepo = new AppRepository(drizzle(sqlite, { schema }), undefined, repos, schema, { sourceFilesystemPolicy: ISOLATED_SOURCE_FILESYSTEM });
  const plan = repo.createProfile("Isolated", sourceId);
  const revision = repo.recordSourceRevision({ sourceId, upstreamRevisionKey: "a", manifestDigest: "a".repeat(64), snapshotLocator: `${sourceId}/revisions/a`, syncedAt: "2026-01-01", completeness: "complete" });
  sqlite.prepare("UPDATE projects SET current_source_revision_id = ? WHERE id = ?").run(revision.id, sourceId);
  const inputSet = sqlite.prepare("INSERT INTO plan_revision_input_sets (tenant_id, profile_id, input_set_digest, expected_input_count, format_version, recorded_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("default", plan.id, "fixture", 0, 2, "2026-01-01", "2026-01-01");
  sqlite.prepare("INSERT INTO plan_accepted_input_sets (tenant_id, profile_id, input_set_id, accepted_at) VALUES (?, ?, ?, ?)").run("default", plan.id, Number(inputSet.lastInsertRowid), "2026-01-01");
  const tables = ["table:app_settings", "table:build_profiles", "table:parts", "table:plan_accepted_input_sets", "table:plan_revision_input_sets", "table:plan_revision_inputs", "table:profile_layers", "table:projects", "table:source_revisions"];
  const union = new Set<string>();
  async function trace(path: string | null, calls: [string, string][], revisionCalls = revisionProbes, refused = false) {
    sqlite.prepare("UPDATE projects SET local_path = ? WHERE id = ?").run(path, sourceId);
    statements = [];
    observer.state.files = [];
    observer.state.active = true;
    let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
    try { output = await tenantStorage.run("default", () => invokeAssistantTool("list_plans", {}, { repo: isolatedRepo })); }
    finally { observer.state.active = false; }
    expect(JSON.parse(output.content)).toEqual(refused
      ? { error: "Active Source revision has an unsafe snapshot locator" }
      : { plans: [{ id: plan.id, name: "Isolated", part_count: 0, build_stale: true }] });
    expect(observer.state.files.map(({ api, args }) => [api, ...args])).toEqual([...calls, ...revisionCalls]);
    const observed = [...new Set(statements.flatMap((sql) => resourcesForPlanSelect(sql, "default")))].sort();
    expect(observed).toEqual(tables);
    for (const sql of statements) expect(() => resourcesForPlanSelect(sql, "other")).toThrow("Unsupported SQL:");
    for (const resource of observed) union.add(resource);
    for (const resource of fileResources([repos], true)) union.add(resource);
  }
  const prefix: [string, string][] = [["realpathSync", repos], ["lstatSync", workspace], ["realpathSync", workspace]];
  const revisionProbes: [string, string][] = [...prefix, ["realpathSync", revisionRoot], ["statSync", revisionRoot]];
  await trace(revisionRoot, revisionProbes);
  await trace(workspace, [...prefix, ["realpathSync", workspace], ["statSync", workspace]]);
  await trace(join(workspace, "missing"), [...prefix, ["realpathSync", join(workspace, "missing")]]);
  await trace(escape, [...prefix, ["realpathSync", escape]]);
  await trace(userRoot, [["realpathSync", repos]]);
  await trace(null, []);
  fs.rmSync(revisionRoot, { recursive: true });
  fs.symlinkSync(userRoot, revisionRoot, "dir");
  await trace(workspace, [...prefix, ["realpathSync", workspace], ["statSync", workspace]], [...prefix, ["realpathSync", revisionRoot]], true);
  fs.rmSync(revisionRoot);
  fs.mkdirSync(revisionRoot);
  fs.rmSync(workspace, { recursive: true });
  fs.symlinkSync(userRoot, workspace, "dir");
  await trace(workspace, [["realpathSync", repos], ["lstatSync", workspace]], [["realpathSync", repos], ["lstatSync", workspace]], true);
  fs.rmSync(workspace);
  await trace(workspace, [["realpathSync", repos], ["lstatSync", workspace]], [["realpathSync", repos], ["lstatSync", workspace]], true);
  statements = [];
  observer.state.files = [];
  observer.state.active = true;
  let other: Awaited<ReturnType<typeof invokeAssistantTool>>;
  try { other = await tenantStorage.run("other", () => invokeAssistantTool("list_plans", {}, { repo: isolatedRepo })); }
  finally { observer.state.active = false; }
  expect(JSON.parse(other.content)).toEqual({ plans: [] });
  expect([...new Set(statements.flatMap((sql) => resourcesForPlanSelect(sql, "other")))].sort()).toEqual(["table:app_settings", "table:build_profiles", "table:parts"]);
  expect(observer.state.files).toEqual([]);
  expect([...union].sort()).toEqual(["file:source-workspace", ...tables]);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.list_plans");
  if (!entry || entry.operation === "source.sync") throw new Error("Missing list plans declaration");
  expect(entry.resources.map(({ kind, name }) => `${kind}:${name}`).sort()).toEqual(["file:source-workspace", ...tables]);
});

function resourcesForPlanSelect(statement: unknown, tenantId: string): string[] {
  const sql = z.string().parse(statement);
  const activeTenant = `'${tenantId.replaceAll("'", "''")}'`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const columns = '"[a-z_]+"(?:, "[a-z_]+")*';
  const ids = '-?(?:0|[1-9][0-9]*)(?:\\.0)?(?:, -?(?:0|[1-9][0-9]*)(?:\\.0)?)*';
  const profileColumns = ["id", "tenant_id", "name", "order_number", "special_request", "config_modified_at", "last_recomputed_at", "archived_at", "last_used_at", "accepted_plan_revision_id", "accepted_plan_version"].map((column) => `"build_profiles"."${column}"`).join(", ");
  const header = `select ${profileColumns}, count("parts"."id") from "build_profiles" left join "parts" on "parts"."profile_id" = "build_profiles"."id" where "build_profiles"."tenant_id" = '${tenantId.replaceAll("'", "''")}' group by "build_profiles"."id" order by "build_profiles"."name" asc`;
  if (sql === header) return ["table:build_profiles", "table:parts"];
  for (const [table, key, suffix] of [
    ["profile_layers", "profile_id", ' order by "profile_layers"."layer_order" asc'],
    ["projects", "id", ""],
    ["source_revisions", "id", ""],
    ["plan_accepted_input_sets", "profile_id", ""],
    ["plan_revision_input_sets", "id", ""],
    ["plan_revision_inputs", "input_set_id", ""],
  ]) {
    const published = table === "plan_revision_input_sets" ? ` and "${table}"\\."published_at" is not null` : "";
    const pattern = new RegExp(`^select ${columns} from "${table}" where \\("${table}"\\."tenant_id" = ${activeTenant} and "${table}"\\."${key}" in \\(${ids}\\)${published}\\)${suffix}$`);
    if (pattern.test(sql)) return [`table:${table}`];
  }
  return [tableForObservedSelect(sql, tenantId)];
}


it("rejects an undeclared real read after list_plans returns", async () => {
  statements = [];
  observer.state.files = [];
  observer.state.active = true;
  let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
  try {
    output = await invokeAssistantTool("list_plans", {}, { repo });
    repo.listSources();
  } finally { observer.state.active = false; }
  expect(JSON.parse(output.content)).toEqual({ plans: [] });
  const observed = [...new Set(statements.flatMap((sql) => resourcesForPlanSelect(sql, "default")))].sort();
  expect(observed).toEqual(["table:app_settings", "table:build_profiles", "table:parts", "table:projects", "table:source_docs"]);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.list_plans");
  if (!entry || entry.operation === "source.sync") throw new Error("Missing list plans declaration");
  const declared = entry.resources.map(({ kind, name }) => `${kind}:${name}`).sort();
  expect(observed.filter((resource) => !declared.includes(resource))).toEqual(["table:source_docs"]);
  expect(observer.state.files).toEqual([]);
});


it("traces get_job_status lookup, filters and tenants against its reviewed empty union", async () => {
  vi.useFakeTimers({ toFake: ["setImmediate", "Date"] });
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const jobs = createJobRunner(() => repo, dataDir);
    const first = await jobs.start("export-stl-pack", { profile_id: 7 }, "default");
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    const second = await jobs.start("export-stl-pack", { profile_id: 8 }, "default");
    const foreign = await jobs.start("export-stl-pack", { profile_id: 7 }, "other");
    await jobs.cancel(second, "default");
    const pending = (job_id: string) => ({ job_id, kind: "export-stl-pack", status: "pending", message: "Queued", progress: 0, result: null, error: null });
    const cancelled = { ...pending(second), status: "cancelled", message: "Cancelled", finished_at: "2026-01-02T00:00:00.000Z" };
    const listedFirst = { ...pending(first), updated_at: "2026-01-01T00:00:00.000Z" };
    const listedSecond = { ...cancelled, updated_at: "2026-01-02T00:00:00.000Z" };
    const listedForeign = { ...pending(foreign), updated_at: "2026-01-02T00:00:00.000Z" };
    async function status(input: Record<string, unknown>, tenantId?: string, available = true) {
      statements = [];
      observer.state.files = [];
      observer.state.active = true;
      let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
      try { output = await tenantStorage.run(tenantId ?? "default", () => invokeAssistantTool("get_job_status", input, { repo, jobs: available ? jobs : undefined, tenantId })); }
      finally { observer.state.active = false; }
      expect(statements).toEqual([]);
      expect(observer.state.files).toEqual([]);
      return z.record(z.string(), z.unknown()).parse(JSON.parse(output.content));
    }
    expect(await status({}, undefined, false)).toEqual({ error: "Job status is unavailable in this context" });
    expect(await status({ job_id: ` ${first} `, status: "cancelled", profile_id: 8 })).toEqual({ job: pending(first) });
    expect(await status({ job_id: second })).toEqual({ job: cancelled });
    expect(await status({ job_id: "missing" })).toEqual({ error: "Job not found" });
    expect(await status({ job_id: foreign })).toEqual({ error: "Job not found" });
    expect(await status({ job_id: first }, "other")).toEqual({ error: "Job not found" });
    expect(await status({ job_id: foreign }, "other")).toEqual({ job: pending(foreign) });
    expect(await status({})).toEqual({ jobs: [listedSecond, listedFirst] });
    expect(await status({ job_id: "  ", status: "pending" })).toEqual({ jobs: [listedFirst] });
    expect(await status({ job_id: 42, status: "cancelled" })).toEqual({ jobs: [listedSecond] });
    expect(await status({ profile_id: "7" })).toEqual({ jobs: [listedFirst] });
    expect(await status({ profile_id: 8 })).toEqual({ jobs: [listedSecond] });
    expect(await status({ profile_id: 999 })).toEqual({ jobs: [] });
    expect(await status({ since: "2026-01-02T00:00:00Z" })).toEqual({ jobs: [listedSecond] });
    expect(await status({ since: "2027-01-01" })).toEqual({ jobs: [] });
    expect(await status({ since: "invalid", profile_id: "invalid", status: 42 })).toEqual({ jobs: [listedSecond, listedFirst] });
    expect(await status({ status: "unknown" })).toEqual({ jobs: [] });
    expect(await status({ status: "pending", profile_id: 7, since: "2026-01-02" })).toEqual({ jobs: [] });
    expect(await status({}, "other")).toEqual({ jobs: [listedForeign] });
    expect(await status({}, "empty")).toEqual({ jobs: [] });
    vi.setSystemTime(new Date("2026-01-04T00:00:00Z"));
    expect(await status({ job_id: second })).toEqual({ error: "Job not found" });
    expect(await status({})).toEqual({ jobs: [listedFirst] });
    const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.get_job_status");
    expect(entry).toEqual({ operation: "tool.get_job_status", resources: [] });
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("rejects observed reads against the empty get_job_status declaration", async () => {
  statements = [];
  observer.state.files = [];
  observer.state.active = true;
  try {
    await invokeAssistantTool("get_job_status", {}, { repo });
    repo.listSources();
    fs.readFileSync(join(root, "README.md"), "utf8");
  } finally { observer.state.active = false; }
  expect([...new Set(statements.map((sql) => tableForObservedSelect(sql)))]).toEqual(["table:projects", "table:source_docs"]);
  expect(observer.state.files.map(({ api }) => api)).toEqual(["readFileSync"]);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.get_job_status");
  expect(entry).toEqual({ operation: "tool.get_job_status", resources: [] });
  expect(() => expect(statements).toEqual([])).toThrow();
  expect(() => expect(observer.state.files).toEqual([])).toThrow();
});


it("traces list_plan_snapshots identity, summaries and tenants against its literal union", async () => {
  const plan = repo.createProfile("Snapshots");
  const empty = repo.createProfile("Empty");
  const foreign = tenantStorage.run("other", () => repo.createProfile("Foreign"));
  const first = repo.createPlanSnapshot({ planId: plan.id, name: "Newer", source: "user", payload: { secret: "not returned" } });
  const second = repo.createPlanSnapshot({ planId: plan.id, name: "Older", source: "user", payload: {} });
  sqlite.prepare("UPDATE plan_snapshots SET created_at = ? WHERE id = ?").run("2026-01-02", first.id);
  sqlite.prepare("UPDATE plan_snapshots SET created_at = ? WHERE id = ?").run("2026-01-01", second.id);
  const other = tenantStorage.run("other", () => repo.createPlanSnapshot({ planId: foreign.id, name: "Other", source: "user", payload: {} }));
  // A colliding profile ID proves the snapshot SELECT itself filters the tenant.
  sqlite.prepare("INSERT INTO plan_snapshots (tenant_id, profile_id, name, created_at, source, payload_json) VALUES (?, ?, ?, ?, ?, ?)").run("other", plan.id, "Hidden", "2026-01-03", "user", "{}");
  const identity = ["table:build_profiles"];
  const tables = ["table:build_profiles", "table:plan_snapshots"];
  const union = new Set<string>();
  async function trace(input: Record<string, unknown>, expected: string[], tenantId = "default", activePlanId?: number) {
    statements = [];
    observer.state.files = [];
    observer.state.active = true;
    let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
    try { output = await tenantStorage.run(tenantId, () => invokeAssistantTool("list_plan_snapshots", input, { repo, activePlanId })); }
    finally { observer.state.active = false; }
    const observed = [...new Set(statements.map((statement) => {
      const sql = z.string().parse(statement);
      const escapedTenant = tenantId.replaceAll("'", "''");
      const snapshot = /^select "id", "tenant_id", "profile_id", "name", "created_at", "source", "payload_json" from "plan_snapshots" where \("plan_snapshots"\."tenant_id" = '([^']*)' and "plan_snapshots"\."profile_id" = (-?[0-9]+(?:\.0)?)\) order by "plan_snapshots"\."created_at" asc$/;
      const match = snapshot.exec(sql);
      if (!match) return tableForObservedSelect(sql, tenantId);
      expect(match[1]).toBe(escapedTenant);
      return "table:plan_snapshots";
    }))].sort();
    expect(observed).toEqual(expected);
    expect(observer.state.files).toEqual([]);
    for (const resource of observed) union.add(resource);
    return z.record(z.string(), z.unknown()).parse(JSON.parse(output.content));
  }
  const summaries = [
    { id: second.id, plan_id: plan.id, name: "Older", created_at: "2026-01-01", source: "user" },
    { id: first.id, plan_id: plan.id, name: "Newer", created_at: "2026-01-02", source: "user" },
  ];
  expect(await trace({}, [])).toEqual({ error: "plan_id required" });
  expect(await trace({ plan_id: "invalid" }, [])).toEqual({ error: "plan_id required" });
  expect(await trace({ plan_id: 999999 }, identity)).toEqual({ error: "plan_id required" });
  expect(await trace({ plan_id: foreign.id }, identity)).toEqual({ error: "plan_id required" });
  expect(await trace({ plan_id: plan.id }, tables)).toEqual({ plan_id: plan.id, snapshots: summaries });
  expect(await trace({ plan_id: String(plan.id) }, tables, "default", empty.id)).toEqual({ plan_id: plan.id, snapshots: summaries });
  expect(await trace({ plan_id: empty.id }, tables)).toEqual({ plan_id: empty.id, snapshots: [] });
  expect(await trace({}, ["table:plan_snapshots"], "default", plan.id)).toEqual({ plan_id: plan.id, snapshots: summaries });
  expect(await trace({ plan_id: foreign.id }, tables, "default", plan.id)).toEqual({ plan_id: plan.id, snapshots: summaries });
  expect(await trace({}, ["table:plan_snapshots"], "default", foreign.id)).toEqual({ plan_id: foreign.id, snapshots: [] });
  const { payload: _payload, ...otherSummary } = other;
  expect(await trace({ plan_id: foreign.id }, tables, "other")).toEqual({ plan_id: foreign.id, snapshots: [otherSummary] });
  expect(await trace({ plan_id: plan.id }, identity, "other")).toEqual({ error: "plan_id required" });
  expect([...union].sort()).toEqual(tables);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.list_plan_snapshots");
  expect(entry).toEqual({ operation: "tool.list_plan_snapshots", resources: [{ kind: "table", name: "build_profiles" }, { kind: "table", name: "plan_snapshots" }] });
});


it("traces ui_highlight_part proposals, selectors and tenants against its literal union", async () => {
  const plan = repo.createProfile("Highlight");
  const fallback = repo.createProfile("Fallback");
  const foreign = tenantStorage.run("other", () => repo.createProfile("Other"));
  const tables = ["table:build_profiles"];
  const union = new Set<string>();
  async function trace(input: Record<string, unknown>, expected: string[], tenantId = "default", activePlanId?: number) {
    statements = [];
    observer.state.files = [];
    observer.state.active = true;
    let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
    try { output = await tenantStorage.run(tenantId, () => invokeAssistantTool("ui_highlight_part", input, { repo, activePlanId })); }
    finally { observer.state.active = false; }
    const observed = [...new Set(statements.map((sql) => tableForObservedSelect(sql, tenantId)))].sort();
    expect(observed).toEqual(expected);
    expect(observer.state.files).toEqual([]);
    for (const resource of observed) union.add(resource);
    const content = z.record(z.string(), z.unknown()).parse(JSON.parse(output.content));
    if (content.status === "proposed") {
      const action = z.object({ id: z.uuid() }).passthrough().parse(content.action);
      expect(output.proposedAction).toEqual(action);
      const { id: _id, ...proposal } = action;
      return { ...content, action: proposal };
    }
    expect(output.proposedAction).toBeUndefined();
    return content;
  }
  function proposal(planId: number, partId: number, surface = "review") {
    return {
      status: "proposed",
      note: "Not applied yet — user must confirm via Apply in the UI.",
      action: {
        type: "ui_highlight_part", plan_id: planId, label: `Preview part #${partId}`,
        summary: `Open ${surface} for plan #${planId} and preview part ${partId}.`,
        params: { plan_id: planId, part_id: partId, surface },
      },
    };
  }
  expect(await trace({}, [])).toEqual({ error: "part_id required" });
  expect(await trace({ plan_id: plan.id, part_id: "invalid" }, [])).toEqual({ error: "part_id required" });
  expect(await trace({ part_id: 42 }, [])).toEqual({ error: "plan_id required" });
  expect(await trace({ part_id: 42, plan_id: "invalid" }, [])).toEqual({ error: "plan_id required" });
  expect(await trace({ part_id: 42, plan_id: 999999 }, tables)).toEqual({ error: "plan_id required" });
  expect(await trace({ part_id: 42, plan_id: foreign.id }, tables)).toEqual({ error: "plan_id required" });
  expect(await trace({ part_id: 42, plan_id: plan.id }, tables)).toEqual(proposal(plan.id, 42));
  expect(await trace({ part_id: "43.9", plan_id: String(plan.id), surface: "checkoff" }, tables, "default", fallback.id)).toEqual(proposal(plan.id, 43, "checkoff"));
  expect(await trace({ part_id: -1, plan_id: plan.id, surface: "unknown" }, tables)).toEqual(proposal(plan.id, -1));
  expect(await trace({ part_id: 42 }, [], "default", fallback.id)).toEqual(proposal(fallback.id, 42));
  expect(await trace({ part_id: 42, plan_id: "invalid" }, [], "default", fallback.id)).toEqual(proposal(fallback.id, 42));
  expect(await trace({ part_id: 42, plan_id: foreign.id }, tables, "default", fallback.id)).toEqual(proposal(fallback.id, 42));
  expect(await trace({ part_id: 42 }, [], "default", foreign.id)).toEqual(proposal(foreign.id, 42));
  expect(await trace({ part_id: 42, plan_id: foreign.id }, tables, "other")).toEqual(proposal(foreign.id, 42));
  expect(await trace({ part_id: 42, plan_id: plan.id }, tables, "other")).toEqual({ error: "plan_id required" });
  sqlite.prepare("ALTER TABLE build_profiles RENAME TO unavailable_profiles").run();
  try {
    expect(await trace({ part_id: 42, plan_id: plan.id }, [])).toEqual({ error: "no such table: build_profiles" });
  } finally {
    sqlite.prepare("ALTER TABLE unavailable_profiles RENAME TO build_profiles").run();
  }
  expect([...union].sort()).toEqual(tables);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.ui_highlight_part");
  expect(entry).toEqual({ operation: "tool.ui_highlight_part", resources: [{ kind: "table", name: "build_profiles" }] });
});

it("traces ui_focus_stl_search proposals, query normalization and tenants against its literal union", async () => {
  const plan = repo.createProfile("Search");
  const fallback = repo.createProfile("Fallback");
  const foreign = tenantStorage.run("other", () => repo.createProfile("Other"));
  const tables = ["table:build_profiles"];
  const union = new Set<string>();
  async function trace(input: Record<string, unknown>, expected: string[], tenantId = "default", activePlanId?: number) {
    statements = [];
    observer.state.files = [];
    observer.state.active = true;
    let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
    try { output = await tenantStorage.run(tenantId, () => invokeAssistantTool("ui_focus_stl_search", input, { repo, activePlanId })); }
    finally { observer.state.active = false; }
    const observed = [...new Set(statements.map((sql) => tableForObservedSelect(sql, tenantId)))].sort();
    expect(observed).toEqual(expected);
    expect(observer.state.files).toEqual([]);
    for (const resource of observed) union.add(resource);
    const content = z.record(z.string(), z.unknown()).parse(JSON.parse(output.content));
    if (content.status === "proposed") {
      const action = z.object({ id: z.uuid() }).passthrough().parse(content.action);
      expect(output.proposedAction).toEqual(action);
      const { id: _id, ...proposal } = action;
      return { ...content, action: proposal };
    }
    expect(output.proposedAction).toBeUndefined();
    return content;
  }
  function proposal(planId: number, query = "") {
    return {
      status: "proposed",
      note: "Not applied yet — user must confirm via Apply in the UI.",
      action: {
        type: "ui_focus_stl_search", plan_id: planId,
        label: query ? `STL search “${query}”` : "Focus STL search",
        summary: query ? `Open Sources and search STLs for “${query}”.` : "Open Sources and focus the STL search field.",
        params: query ? { query } : {},
      },
    };
  }
  expect(await trace({}, [])).toEqual(proposal(0));
  for (const query of [null, 42, {}, [], "", "  \n "]) {
    expect(await trace({ query }, [])).toEqual(proposal(0));
  }
  expect(await trace({ query: "  bracket\nplate  " }, [])).toEqual(proposal(0, "bracket\nplate"));
  expect(await trace({ plan_id: "invalid", query: "bracket" }, [])).toEqual(proposal(0, "bracket"));
  expect(await trace({ plan_id: 999999 }, tables)).toEqual(proposal(0));
  expect(await trace({ plan_id: foreign.id }, tables)).toEqual(proposal(0));
  expect(await trace({ plan_id: plan.id, query: " bolt " }, tables)).toEqual(proposal(plan.id, "bolt"));
  expect(await trace({ plan_id: String(plan.id) }, tables, "default", fallback.id)).toEqual(proposal(plan.id));
  expect(await trace({}, [], "default", fallback.id)).toEqual(proposal(fallback.id));
  expect(await trace({ plan_id: "invalid" }, [], "default", fallback.id)).toEqual(proposal(fallback.id));
  expect(await trace({ plan_id: foreign.id }, tables, "default", fallback.id)).toEqual(proposal(fallback.id));
  expect(await trace({}, [], "default", foreign.id)).toEqual(proposal(foreign.id));
  expect(await trace({ plan_id: foreign.id }, tables, "other")).toEqual(proposal(foreign.id));
  expect(await trace({ plan_id: plan.id }, tables, "other")).toEqual(proposal(0));
  sqlite.prepare("ALTER TABLE build_profiles RENAME TO unavailable_profiles").run();
  try {
    expect(await trace({ plan_id: plan.id }, [])).toEqual({ error: "no such table: build_profiles" });
  } finally {
    sqlite.prepare("ALTER TABLE unavailable_profiles RENAME TO build_profiles").run();
  }
  expect([...union].sort()).toEqual(tables);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.ui_focus_stl_search");
  expect(entry).toEqual({ operation: "tool.ui_focus_stl_search", resources: [{ kind: "table", name: "build_profiles" }] });
});

it("traces ui_navigate routes, normalization, ID precedence and tenants against its literal union", async () => {
  const plan = repo.createProfile("Search");
  const fallback = repo.createProfile("Fallback");
  const foreign = tenantStorage.run("other", () => repo.createProfile("Other"));
  const tables = ["table:build_profiles"];
  const union = new Set<string>();
  async function trace(input: Record<string, unknown>, expected: string[], tenantId = "default", activePlanId?: number) {
    statements = [];
    observer.state.files = [];
    observer.state.active = true;
    let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
    try { output = await tenantStorage.run(tenantId, () => invokeAssistantTool("ui_navigate", input, { repo, activePlanId })); }
    finally { observer.state.active = false; }
    const observed = [...new Set(statements.map((sql) => tableForObservedSelect(sql, tenantId)))].sort();
    expect(observed).toEqual(expected);
    expect(observer.state.files).toEqual([]);
    for (const resource of observed) union.add(resource);
    const content = z.record(z.string(), z.unknown()).parse(JSON.parse(output.content));
    if (content.status === "proposed") {
      const action = z.object({ id: z.uuid() }).passthrough().parse(content.action);
      expect(output.proposedAction).toEqual(action);
      const { id: _id, ...proposal } = action;
      return { ...content, action: proposal };
    }
    expect(output.proposedAction).toBeUndefined();
    return content;
  }
  function proposal(route: string, planId: number) {
    return {
      status: "proposed",
      note: "Not applied yet — user must confirm via Apply in the UI.",
      action: {
        type: "ui_navigate", plan_id: planId,
        label: `Open ${route}`,
        summary: `Navigate to ${route}${planId > 0 ? ` (plan #${planId})` : ""}.`,
        params: planId > 0 ? { route, profile_id: planId } : { route },
      },
    };
  }
  for (const route of ["sources", "build", "review", "checkoff", "settings", "builds", "help"]) {
    expect(await trace({ route }, [])).toEqual(proposal(route, 0));
    expect(await trace({ route: `  ${route}\n`, plan_id: plan.id }, tables)).toEqual(proposal(route, plan.id));
  }
  for (const [input, route] of [
    [{}, ""], [{ route: null }, ""], [{ route: " BUILD " }, "BUILD"],
    [{ route: 42 }, "42"], [{ route: {} }, "[object Object]"], [{ route: [] }, ""],
  ] satisfies [Record<string, unknown>, string][]) {
    expect(await trace({ ...input, plan_id: plan.id }, [])).toEqual({ error: `Invalid route: ${route}` });
  }
  for (const planId of [plan.id, String(plan.id), ` ${plan.id}.9 `]) {
    expect(await trace({ route: "build", plan_id: planId, profile_id: foreign.id }, tables, "default", fallback.id)).toEqual(proposal("build", plan.id));
  }
  for (const planId of ["invalid", null, {}, []]) {
    expect(await trace({ route: "build", plan_id: planId, profile_id: String(fallback.id) }, [])).toEqual(proposal("build", fallback.id));
  }
  for (const planId of [999999, foreign.id, 0, -1]) {
    expect(await trace({ route: "review", plan_id: planId }, tables)).toEqual(proposal("review", 0));
    expect(await trace({ route: "review", plan_id: planId, profile_id: foreign.id }, tables)).toEqual(proposal("review", foreign.id));
    expect(await trace({ route: "review", plan_id: planId, profile_id: foreign.id }, tables, "default", fallback.id)).toEqual(proposal("review", fallback.id));
  }
  expect(await trace({ route: "help", profile_id: foreign.id }, [])).toEqual(proposal("help", foreign.id));
  expect(await trace({ route: "help", profile_id: "invalid" }, [])).toEqual(proposal("help", 0));
  expect(await trace({ route: "help", profile_id: -2 }, [])).toEqual(proposal("help", -2));
  expect(await trace({ route: "help", profile_id: plan.id }, [], "default", foreign.id)).toEqual(proposal("help", foreign.id));
  expect(await trace({ route: "help", profile_id: plan.id }, [], "default", 0)).toEqual(proposal("help", 0));
  expect(await trace({ route: "help", plan_id: foreign.id }, tables, "other")).toEqual(proposal("help", foreign.id));
  expect(await trace({ route: "help", plan_id: plan.id }, tables, "other")).toEqual(proposal("help", 0));
  sqlite.prepare("ALTER TABLE build_profiles RENAME TO unavailable_profiles").run();
  try {
    expect(await trace({ route: "build", plan_id: plan.id, profile_id: fallback.id }, [], "default", fallback.id)).toEqual({ error: "no such table: build_profiles" });
    expect(await trace({ route: "help", profile_id: plan.id }, [])).toEqual(proposal("help", plan.id));
  } finally {
    sqlite.prepare("ALTER TABLE unavailable_profiles RENAME TO build_profiles").run();
  }
  expect([...union].sort()).toEqual(tables);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === "tool.ui_navigate");
  expect(entry).toEqual({ operation: "tool.ui_navigate", resources: [{ kind: "table", name: "build_profiles" }] });
});

it.each(["ui_open_source", "ui_open_docs"] as const)("traces %s selectors, proposals and tenants against its literal union", async (tool) => {
  const plan = repo.createProfile("Open source");
  const fallback = repo.createProfile("Fallback");
  const foreign = tenantStorage.run("other", () => ({
    source: repo.createSource({ name: "Fixture", source_kind: "local", local_path: userRoot }),
    plan: repo.createProfile("Other"),
  }));
  const sources = ["table:projects", "table:source_docs"];
  const tables = ["table:build_profiles", ...sources];
  const union = new Set<string>();
  async function trace(input: Record<string, unknown>, expected: string[], tenantId = "default", activePlanId?: number) {
    statements = [];
    observer.state.files = [];
    observer.state.active = true;
    let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
    try { output = await tenantStorage.run(tenantId, () => invokeAssistantTool(tool, input, { repo, activePlanId })); }
    finally { observer.state.active = false; }
    const observed = [...new Set(statements.map((sql) => tableForObservedSelect(sql, tenantId)))].sort();
    expect(observed).toEqual(expected);
    expect(observer.state.files).toEqual([]);
    for (const resource of observed) union.add(resource);
    const content = z.record(z.string(), z.unknown()).parse(JSON.parse(output.content));
    if (content.status === "proposed") {
      const action = z.object({ id: z.uuid() }).passthrough().parse(content.action);
      expect(output.proposedAction).toEqual(action);
      const { id: _id, ...proposal } = action;
      return { ...content, action: proposal };
    }
    expect(output.proposedAction).toBeUndefined();
    return content;
  }
  function proposal(id: number, name = "Fixture", tab = "docs", planId = 0, extra: Record<string, string> = {}) {
    return {
      status: "proposed",
      note: "Not applied yet — user must confirm via Apply in the UI.",
      action: {
        type: tool, plan_id: planId,
        label: `Open ${name} ${tab}`,
        summary: `Open source “${name}” (${tab}).`,
        params: { source_name: name, source_id: id, tab, ...extra },
      },
    };
  }
  for (const input of [{}, { source_id: "invalid" }, { source_name: "  " }, { source_name: 42 }]) {
    expect(await trace({ ...input, plan_id: plan.id }, [])).toEqual({ error: "source_name or source_id required" });
  }
  for (const id of [sourceId, String(sourceId), ` ${sourceId}.9 `]) {
    expect(await trace({ source_id: id, source_name: "UserLocal" }, sources)).toEqual(proposal(sourceId));
  }
  for (const name of [" Fixture ", "fixture", "Fix-ture", "Fixture @ v2.1"]) {
    expect(await trace({ source_name: name }, sources)).toEqual(proposal(sourceId));
  }
  expect(await trace({ source_id: "invalid", source_name: "Fixture" }, sources)).toEqual(proposal(sourceId));
  expect(await trace({ source_name: "Fixtur" }, sources)).toEqual(proposal(sourceId));
  expect(await trace({ source_name: "zqxwv" }, sources)).toEqual({ error: 'Source not found: "zqxwv". Use list_sources.' });
  expect(await trace({ source_name: "Fixtxre" }, sources)).toEqual({ error: 'Source not found: "Fixtxre". Did you mean: "Fixture"? Use list_sources.' });
  for (const id of [999999, foreign.source.id, 0, -1]) {
    expect(await trace({ source_id: id, source_name: "Fixture", plan_id: plan.id }, ["table:projects"])).toEqual({ error: "Source not found" });
  }
  for (const tab of ["docs", "rules", "naming"]) {
    expect(await trace({ source_id: sourceId, tab, path: " ../outside.md ", query: " bolt " }, sources)).toEqual(proposal(sourceId, "Fixture", tool === "ui_open_docs" ? "docs" : tab, 0, { path: " ../outside.md ", query: " bolt " }));
  }
  for (const tab of [" Rules ", "other", null, 42]) {
    expect(await trace({ source_id: sourceId, tab, path: 42, query: {} }, sources)).toEqual(proposal(sourceId));
  }
  for (const planId of [plan.id, String(plan.id)]) {
    expect(await trace({ source_id: sourceId, plan_id: planId, profile_id: foreign.plan.id }, tables, "default", fallback.id)).toEqual(proposal(sourceId, "Fixture", "docs", plan.id));
  }
  for (const planId of [foreign.plan.id, 999999]) {
    expect(await trace({ source_id: sourceId, plan_id: planId }, tables)).toEqual(proposal(sourceId));
    expect(await trace({ source_id: sourceId, plan_id: planId }, tables, "default", fallback.id)).toEqual(proposal(sourceId, "Fixture", "docs", fallback.id));
  }
  expect(await trace({ source_id: sourceId, plan_id: "invalid" }, sources, "default", fallback.id)).toEqual(proposal(sourceId, "Fixture", "docs", fallback.id));
  expect(await trace({ source_id: sourceId, profile_id: plan.id }, sources)).toEqual(proposal(sourceId));
  expect(await trace({ source_id: sourceId }, sources, "default", foreign.plan.id)).toEqual(proposal(sourceId, "Fixture", "docs", foreign.plan.id));
  expect(await trace({ source_id: foreign.source.id, plan_id: foreign.plan.id }, tables, "other")).toEqual(proposal(foreign.source.id, "Fixture", "docs", foreign.plan.id));
  expect(await trace({ source_name: "Fixture" }, sources, "other")).toEqual(proposal(foreign.source.id));
  expect(await trace({ source_id: sourceId }, ["table:projects"], "other")).toEqual({ error: "Source not found" });
  for (const table of ["projects", "source_docs", "build_profiles"]) {
    sqlite.prepare(`ALTER TABLE ${table} RENAME TO unavailable_table`).run();
    try {
      const expected = table === "projects" ? [] : table === "source_docs" ? ["table:projects"] : sources;
      expect(await trace({ source_id: sourceId, plan_id: plan.id }, expected)).toEqual({ error: `no such table: ${table}` });
    } finally {
      sqlite.prepare(`ALTER TABLE unavailable_table RENAME TO ${table}`).run();
    }
  }
  expect([...union].sort()).toEqual(tables);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === `tool.${tool}`);
  if (!entry || entry.operation === "source.sync") throw new Error("Missing open source declaration");
  expect(entry.resources.map(({ kind, name }) => `${kind}:${name}`).sort()).toEqual(["file:source-workspace", ...tables]);
});

it.each(["ui_open_source", "ui_open_docs"] as const)("traces %s isolated workspace probes without opening proposed paths", async (tool) => {
  const repos = join(dataDir, "repos");
  const workspace = join(repos, String(sourceId));
  fs.mkdirSync(workspace, { recursive: true });
  const escape = join(workspace, "escape");
  fs.symlinkSync(userRoot, escape, "dir");
  const isolatedRepo = new AppRepository(drizzle(sqlite, { schema }), undefined, repos, schema, { sourceFilesystemPolicy: ISOLATED_SOURCE_FILESYSTEM });
  const plan = repo.createProfile("Isolated");
  const tables = ["table:build_profiles", "table:projects", "table:source_docs"];
  const union = new Set<string>();
  const prefix: [string, string][] = [["realpathSync", repos], ["lstatSync", workspace], ["realpathSync", workspace]];
  async function trace(path: string | null, calls: [string, string][], byName = false) {
    sqlite.prepare("UPDATE projects SET local_path = ? WHERE id = ?").run(path, sourceId);
    statements = [];
    observer.state.files = [];
    observer.state.active = true;
    let output: Awaited<ReturnType<typeof invokeAssistantTool>>;
    try {
      output = await invokeAssistantTool(tool, {
        ...(byName ? { source_name: "Fixture" } : { source_id: sourceId }),
        plan_id: plan.id, path: "../outside.txt", query: "README",
      }, { repo: isolatedRepo });
    } finally { observer.state.active = false; }
    const content = z.object({ status: z.literal("proposed"), action: z.object({ id: z.uuid() }).passthrough() }).passthrough().parse(JSON.parse(output.content));
    expect(output.proposedAction).toEqual(content.action);
    const { id: _id, ...action } = content.action;
    expect(action).toEqual({
      type: tool, plan_id: plan.id, label: "Open Fixture docs",
      summary: "Open source “Fixture” (docs).",
      params: { source_name: "Fixture", source_id: sourceId, tab: "docs", path: "../outside.txt", query: "README" },
    });
    expect(observer.state.files.map(({ api, args }) => [api, ...args])).toEqual(calls);
    const observed = [...new Set(statements.map((sql) => tableForObservedSelect(sql)))].sort();
    expect(observed).toEqual(tables);
    for (const sql of statements) expect(() => tableForObservedSelect(sql, "other")).toThrow("Unsupported SQL:");
    for (const resource of [...observed, ...fileResources([repos], true)]) union.add(resource);
  }
  await trace(workspace, [...prefix, ["realpathSync", workspace], ["statSync", workspace]]);
  await trace(join(workspace, "missing"), [...prefix, ["realpathSync", join(workspace, "missing")]]);
  await trace(escape, [...prefix, ["realpathSync", escape]]);
  await trace(userRoot, [["realpathSync", repos]]);
  await trace(null, []);
  sqlite.prepare("UPDATE projects SET local_path = NULL WHERE id != ?").run(sourceId);
  await trace(workspace, [...prefix, ["realpathSync", workspace], ["statSync", workspace]], true);
  fs.rmSync(workspace, { recursive: true });
  fs.symlinkSync(userRoot, workspace, "dir");
  await trace(workspace, [["realpathSync", repos], ["lstatSync", workspace]]);
  fs.rmSync(workspace);
  await trace(workspace, [["realpathSync", repos], ["lstatSync", workspace]]);
  statements = [];
  observer.state.files = [];
  observer.state.active = true;
  let other: Awaited<ReturnType<typeof invokeAssistantTool>>;
  try { other = await tenantStorage.run("other", () => invokeAssistantTool(tool, { source_id: sourceId }, { repo: isolatedRepo })); }
  finally { observer.state.active = false; }
  expect(JSON.parse(other.content)).toEqual({ error: "Source not found" });
  expect(statements.map((sql) => tableForObservedSelect(sql, "other"))).toEqual(["table:projects"]);
  expect(observer.state.files).toEqual([]);
  expect([...union].sort()).toEqual(["file:source-workspace", ...tables]);
  const entry = manifest.resources.reviewed.find((entry) => entry.operation === `tool.${tool}`);
  if (!entry || entry.operation === "source.sync") throw new Error("Missing open source declaration");
  expect(entry.resources.map(({ kind, name }) => `${kind}:${name}`).sort()).toEqual(["file:source-workspace", ...tables]);
});
