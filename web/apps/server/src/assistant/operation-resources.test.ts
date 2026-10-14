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
  z.object({ operation: z.enum(["tool.read_source_file", "tool.list_sources", "tool.list_source_categories", "tool.search_source_files", "tool.preview_source_naming", "tool.get_workflow_help"]),
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
