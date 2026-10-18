// Requires Node 22.x and npm --prefix web ci --ignore-scripts.
// node --import ./web/node_modules/tsx/dist/loader.mjs --conditions=development \
//   fixtures/parity/review-refusals/generate.mjs [--check]
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const check = process.argv.includes("--check");
const database = "rust/crates/pp-storage/tests/fixtures/accepted-plan-node.db";
const review = "web/apps/server/src/services/accepted-plan-review.ts";
const { createSelfHostPorts } = await import(join(root, "web/apps/server/src/adapters/self-host/index.ts"));
const { readAcceptedPlanReview } = await import(join(root, review));
const { AcceptedPlanOperationalIntegrityError } = await import(join(root, "web/apps/server/src/db/accepted-plan-operational.ts"));

// PPJS v1 is magic, a big-endian u32 UTF-16 unit count, then big-endian units.
const truncatedPpjs = "X'50504A5301'";
const loneHigh = "X'50504A530100000001D800'";
const loneLow = "X'50504A530100000001DC00'";
const cases = [
  ["malformed-parts-ppjs", `UPDATE parts SET requirement=${truncatedPpjs} WHERE id=1`],
  ["malformed-plan-revision-parts-ppjs", `UPDATE plan_revision_parts SET requirement=${truncatedPpjs} WHERE id=1`],
  ["non-scalar-metadata-stale-digest", `UPDATE parts SET requirement=${loneHigh},option_group_id=${loneLow} WHERE id=1;UPDATE plan_revision_parts SET requirement=${loneHigh},option_group_id=${loneLow} WHERE id=1`],
  ["non-scalar-projection-mismatch", `UPDATE parts SET requirement=${loneHigh} WHERE id=1`],
  ["unrelated-renamed-column", "ALTER TABLE plan_revision_parts RENAME COLUMN notes TO notes_renamed"],
];
const rowsQuery = "SELECT 'parts',id,quote(requirement),quote(option_group_id) FROM parts UNION ALL SELECT 'plan_revision_parts',id,quote(requirement),quote(option_group_id) FROM plan_revision_parts UNION ALL SELECT 'plan_revisions',id,quote(snapshot_digest),NULL FROM plan_revisions ORDER BY 1,2";
const sentinel = { path: "repos/1/revisions/accepted/sentinel.txt", contents: "review-refusal sentinel\n" };

function mutate(path, sql) {
  const raw = new DatabaseSync(path);
  try {
    const triggers = raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    for (const { name } of triggers) raw.exec(`DROP TRIGGER "${name}"`);
    raw.exec(sql);
    for (const trigger of triggers) {
      try {
        raw.exec(trigger.sql);
      } catch (error) {
        assert.match(String(error), /no such table/);
      }
    }
  } finally {
    raw.close();
  }
}
function rows(path) {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return raw.prepare(rowsQuery).all().map((row) => Object.values(row));
  } catch (error) {
    return { error: String(error.message) };
  } finally {
    raw.close();
  }
}
// Every row of every table, so a write to any column fails the preservation check.
function snapshot(path) {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().flatMap(({ name }) => {
      const columns = raw.prepare("SELECT name FROM pragma_table_info(?)").all(name).map((c) => `quote("${c.name}")`);
      return raw.prepare(`SELECT ${columns.join("||','||")} AS line FROM "${name}" ORDER BY line`).all().map(({ line }) => `${name}:${line}`);
    });
  } finally {
    raw.close();
  }
}
function files(directory) {
  return readdirSync(join(directory, "repos"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [relative(directory, path), readFileSync(path, "utf8")];
    })
    .sort();
}

const output = [];
for (const [name, sql] of cases) {
  const directory = mkdtempSync(join(tmpdir(), "pp-review-refusal-"));
  try {
    const path = join(directory, "print-partner.db");
    copyFileSync(join(root, database), path);
    mkdirSync(join(directory, dirname(sentinel.path)), { recursive: true });
    writeFileSync(join(directory, sentinel.path), sentinel.contents);
    const ports = createSelfHostPorts(directory);
    // connect() migrates, so mutate afterwards or it would restore a dropped table.
    await ports.db.connect();
    mutate(path, sql);
    const rowsBefore = rows(path);
    const databaseBefore = snapshot(path);
    const filesBefore = files(directory);
    let thrown;
    try {
      const result = await readAcceptedPlanReview({
        repo: ports.repository,
        profileId: 1,
        includeExcluded: false,
        reposDir: join(directory, "repos"),
        thumbsDir: null,
      });
      assert.fail(`${name} returned ${result.kind}`);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      thrown = error;
    } finally {
      await ports.db.close();
    }
    assert.deepEqual(rows(path), rowsBefore, `${name} preserved rows`);
    assert.deepEqual(snapshot(path), databaseBefore, `${name} preserved database`);
    assert.deepEqual(files(directory), filesBefore, `${name} preserved files`);
    output.push({
      name,
      sql,
      node: {
        thrown: { name: thrown.name, code: thrown.code ?? null, message: thrown.message },
        // GET /plans/:id/review branches on this instanceof test.
        routeClass: thrown instanceof AcceptedPlanOperationalIntegrityError ? "integrity_failure" : "unexpected",
      },
      preserved: { rows: rowsBefore, files: filesBefore },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const fixture = `${JSON.stringify({ source: review, database, rowsQuery, sentinel, cases: output }, null, 2)}\n`;
const target = join(here, "node.json");
if (check) assert.equal(readFileSync(target, "utf8"), fixture, "node.json is stale");
else writeFileSync(target, fixture);
