import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonical, digest, json, object } from "./model.mjs";

const cli = fileURLToPath(new URL("./gre487.mts", import.meta.url));
const loader = fileURLToPath(import.meta.resolve("tsx"));
function run(args: string[], enabled = "0", path = cli) {
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", loader, path, ...args], {
    env: { ...process.env, GRE487_DELAYED_PATCH: enabled },
    encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}
function receipt(stdout: string) {
  assert.equal(stdout.trim().split("\n").length, 1, "One JSON document on stdout");
  const value = object(json(JSON.parse(stdout)));
  assert.equal(value.format, "gre487-replay-v1");
  return value;
}

test("disabled and unavailable gates do not import the scenario", () => {
  const root = mkdtempSync(join(tmpdir(), "gre487-cli-"));
  const isolatedCli = join(root, "gre487.mts");
  copyFileSync(cli, isolatedCli);
  copyFileSync(new URL("./model.mts", import.meta.url), join(root, "model.mts"));
  try {
    const text = run([], "0", isolatedCli);
    assert.equal(text.status, 0);
    assert.equal(text.stdout, "DISABLED; enable GRE487_DELAYED_PATCH=1 or --enabled and choose --engine=ts\n");
    assert.equal(text.stderr, "");
    for (const args of [["--format=json"], ["--engine=ts", "--format=json"]]) {
      const result = run(args, "0", isolatedCli);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.deepEqual(receipt(result.stdout), {
        format: "gre487-replay-v1", kind: "disabled", typescript: "not-run", rust: "not-run",
      });
    }
    for (const engine of ["rust", "both"]) {
      const args = ["--enabled", `--engine=${engine}`];
      const result = run([...args, "--format=json"], "0", isolatedCli);
      assert.equal(result.status, 2);
      assert.deepEqual(receipt(result.stdout), {
        format: "gre487-replay-v1", kind: "unavailable", engine, typescript: "not-run", rust: "not-run",
      });
      const textResult = run(args, "0", isolatedCli);
      assert.equal(textResult.status, 2);
      assert.equal(textResult.stdout, "");
      assert.equal(textResult.stderr, result.stderr);
      assert.equal(result.stderr, `UNAVAILABLE; --engine=${engine} requires the missing live Rust pp-services draft/save replay. Rust NOT RUN; TypeScript NOT RUN\n`);
    }
    const failure = run(["--enabled", "--engine=ts", "--format=json"], "0", isolatedCli);
    assert.equal(failure.status, 1);
    const failed = receipt(failure.stdout);
    assert.equal(failed.kind, "fail");
    assert.equal("runs" in failed, false);
    assert.equal("evidenceSha256" in failed, false);
    assert.match(String(failed.error), /Cannot find module.*gre487-scenario/);
    assert.match(failure.stderr, /^FAIL;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid and repeated arguments produce failures without pass evidence", () => {
  for (const args of [
    ["--unknown", "--format=json"], ["--format=json", "--unknown"],
    ["--engine=ts", "--engine=both", "--format=json"],
    ["--enabled", "--enabled", "--format=json"], ["--format=json", "--format=json"],
  ]) {
    const result = run(args, "1");
    assert.equal(result.status, 1);
    const failed = receipt(result.stdout);
    assert.equal(failed.kind, "fail");
    assert.equal("runs" in failed, false);
    assert.equal("evidenceSha256" in failed, false);
    assert.match(String(failed.error), /Unknown argument|Repeated argument/);
    assert.match(result.stderr, /^FAIL;/);
  }
  for (const args of [["--unknown"], ["--format=xml"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^FAIL; Error: Unknown argument/);
  }
});

test("explicit and environment TS runs emit equal evidence and recomputable hashes", () => {
  for (const { args, enabled } of [
    { args: ["--enabled", "--engine=ts", "--format=json"], enabled: "0" },
    { args: ["--engine=ts", "--format=json"], enabled: "1" },
  ]) {
    const result = run(args, enabled);
    assert.equal(result.status, 0, result.stderr);
    const passed = receipt(result.stdout);
    assert.equal(passed.kind, "ts-pass");
    assert.equal(passed.rust, "not-run");
    const runs = passed.runs;
    const hashes = passed.evidenceSha256;
    assert(Array.isArray(runs) && runs.length === 2);
    assert(Array.isArray(hashes) && hashes.length === 2);
    assert.deepEqual(runs[0], runs[1]);
    for (const [index, evidence] of runs.entries()) {
      assert.equal(hashes[index], digest(canonical(evidence)));
      assert.match(String(hashes[index]), /^[a-f0-9]{64}$/);
      assert(Array.isArray(evidence));
      const steps = evidence.map(object);
      assert.deepEqual(steps.map((step) => step.step), [
        "D0-held", "fresh-2", "fresh-3", "fresh-4", "held-D0-refused", "draft-reopened", "final-save", "accepted-reopened",
      ]);
      assert.equal(steps[4].status, 409);
      assert.equal(object(steps[4].response).code, "draft_changed");
      assert.deepEqual(object(steps[4].response).workspace, steps[3].workspace);
      assert.deepEqual(steps[4].state, steps[3].state);
      assert.deepEqual(steps[5].state, steps[4].state);
      assert.deepEqual(steps[5].workspace, steps[3].workspace);
      const parts = object(steps[5].workspace).parts;
      assert(Array.isArray(parts));
      assert.deepEqual(parts.map((value) => {
        const part = object(value);
        return [part.filename, part.quantity_effective, part.quantity_override, part.included];
      }), [["a.stl", 4, 4, true], ["b.stl", 1, null, false]]);
      assert.deepEqual(steps[7].state, steps[6].state);
      const saved = object(steps[6].response);
      assert.deepEqual(steps[7].review, saved.review);
      assert.deepEqual(object(steps[6].state).files, object(steps[4].state).files);
      const revisions = object(object(steps[6].state).database).plan_revisions;
      assert(Array.isArray(revisions));
      assert.equal(revisions.length, 2);
      assert.equal(object(saved.receipt).plan_version, 2);
    }
    assert.doesNotMatch(result.stdout, /pp-gre487-/);
    assert.doesNotMatch(result.stderr, /FAIL;|UNAVAILABLE;/);
  }
  const text = run(["--enabled", "--engine=ts"]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, "TS PASS; Rust NOT RUN; two independent replays, three fresh edits, held D0 PATCH refused with 409 draft_changed and exact DB/file no-write, draft reopen, POST save, accepted Review reopen\n");
});
