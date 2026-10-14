import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function json(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)]));
  }
  throw new Error(`Non-JSON fixture value: ${typeof value}`);
}

export function object(value: Json): { [key: string]: Json } {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export const policy = {
  version: "desktop-autosave-v1",
  clock: "2026-09-06T00:00:00.000Z",
  requiredUnitEntropy: "repository tokenFactory, monotonically increasing 128-bit hex fixture tokens",
  rowOrdering: "Each table is ordered ascending by every primary-key column in SQLite PRAGMA table_info pk ordinal order, or every declared column in cid order when no primary key exists. State hashes use recursively sorted JSON object keys and retain array order.",
  normalization: "Replace only the declared temporary data-directory prefix in string values with $DATA. Preserve all IDs, nulls, omissions, enum values, timestamps, hashes, digests, tokens, row counts and array ordering. HTTP ephemeral port and volatile headers are not contract fields and are not captured.",
};

export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalize(value: Json, root: string): Json {
  if (typeof value === "string") return value.replaceAll(root, "$DATA");
  if (Array.isArray(value)) return value.map((item) => normalize(item, root));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, root)]));
  }
  return value;
}

function equal(expected: Json, actual: Json, path: string): void {
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual), `${path}: expected array`);
    assert.equal(actual.length, expected.length, `${path}: array length`);
    expected.forEach((item, index) => equal(item, actual[index], `${path}[${index}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert(actual !== null && typeof actual === "object" && !Array.isArray(actual), `${path}: expected object`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}: object keys`);
    for (const [key, item] of Object.entries(expected)) equal(item, actual[key], `${path}.${key}`);
    return;
  }
  assert.equal(actual, expected, path);
}

function stateId(value: Json, label: string): string {
  assert(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${label}: state id`);
  return value;
}

function assertClosedStateGraph(capture: { [key: string]: Json }): void {
  const states = object(capture.states);
  const referenced = new Set<string>();
  const expectState = (value: Json, label: string) => {
    const id = stateId(value, label);
    referenced.add(id);
    assert(Object.hasOwn(states, id), `Missing state ${id} referenced by ${label}`);
  };
  expectState(capture.initial_state, "initial_state");
  expectState(capture.final_state, "final_state");
  const setup = capture.setup_operations;
  assert(Array.isArray(setup), "setup_operations");
  setup.forEach((entry, index) => expectState(object(entry).state, `setup_operations[${index}].state`));
  const routes = capture.route_cases;
  assert(Array.isArray(routes), "route_cases");
  routes.forEach((entry, index) => {
    const route = object(entry);
    const name = typeof route.name === "string" ? route.name : String(index);
    expectState(route.before, `route_cases.${name}.before`);
    expectState(route.after, `route_cases.${name}.after`);
  });
  for (const id of Object.keys(states)) assert(referenced.has(id), `Unreferenced state ${id}`);
}

function assertRouteStateInvariants(capture: { [key: string]: Json }): void {
  const states = object(capture.states);
  const routes = capture.route_cases;
  assert(Array.isArray(routes), "route_cases");
  routes.forEach((entry, index) => {
    const route = object(entry);
    const name = typeof route.name === "string" ? route.name : String(index);
    const label = `route_cases.${name}`;
    const invariants = route.invariants;
    assert(Array.isArray(invariants), `${label}: invariants`);
    const before = stateId(route.before, `${label}.before`);
    const after = stateId(route.after, `${label}.after`);
    if (invariants.includes("exact-database-and-file-no-write")) {
      assert.equal(before, after, `${label}: exact-database-and-file-no-write requires identical before and after states`);
    }
    if (invariants.includes("one-publication")) {
      assert.notEqual(before, after, `${label}: one-publication requires different before and after states`);
    }
    if (invariants.includes("fixture-file-hashes-unchanged")) {
      const path = `${label}: fixture-file-hashes-unchanged`;
      const beforeFiles = object(states[before]).files;
      const afterFiles = object(states[after]).files;
      assert(Array.isArray(beforeFiles), `${path}.before.files: expected array`);
      assert(Array.isArray(afterFiles), `${path}.after.files: expected array`);
      equal(beforeFiles, afterFiles, path);
    }
    if (invariants.includes("current-plate-head-invalidated")) {
      const heads = object(object(states[after]).database).accepted_plate_heads;
      assert(Array.isArray(heads), `${label}: accepted_plate_heads`);
      assert.equal(heads.length, 0, `${label}: current-plate-head-invalidated requires an empty accepted_plate_heads table`);
    }
  });
}

export function compare(left: Json, right: Json): void {
  const a = object(left);
  const b = object(right);
  assert.equal(a.format, policy.version);
  assert.equal(b.format, policy.version);
  assert.deepEqual(a.policy, policy);
  assert.deepEqual(b.policy, policy);
  for (const corpus of [a, b]) {
    const raw = object(corpus.raw);
    assert.equal(typeof raw.data_directory, "string");
    assert(typeof raw.data_directory === "string");
    equal(normalize(raw.capture, raw.data_directory), corpus.normalized, "Raw and normalized evidence differ");
  }
  equal(a.normalized, b.normalized, "$.normalized");
  const normalized = object(a.normalized);
  for (const [id, state] of Object.entries(object(normalized.states))) {
    assert.equal(digest(canonical(state)), id, `State hash mismatch: ${id}`);
  }
  assertClosedStateGraph(normalized);
  assertRouteStateInvariants(normalized);
}
