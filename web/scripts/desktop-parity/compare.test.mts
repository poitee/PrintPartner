import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonical, compare, digest, json, normalize, object, type Json } from "./model.mjs";

const fixture = new URL("../../packages/contracts/test-fixtures/desktop/autosave-v1.json", import.meta.url);
const golden = json(JSON.parse(readFileSync(fixture, "utf8")));
function changed(update: (capture: { [key: string]: Json }) => void): Json {
  const copy = structuredClone(golden);
  const envelope = object(copy);
  const raw = object(envelope.raw);
  assert(typeof raw.data_directory === "string");
  update(object(raw.capture));
  envelope.normalized = normalize(raw.capture, raw.data_directory);
  return copy;
}
function named(capture: { [key: string]: Json }, collection: string, name: string) {
  const entries = capture[collection];
  assert(Array.isArray(entries));
  const entry = entries.find((value) => object(value).name === name);
  assert(entry);
  return object(entry);
}

test("exact captured corpus compares", () => compare(golden, structuredClone(golden)));
test("declared temporary root is the only normalized value", () => {
  const copy = structuredClone(golden);
  const envelope = object(copy);
  const raw = object(envelope.raw);
  assert(typeof raw.data_directory === "string");
  const nextRoot = "/tmp/independent-capture";
  raw.capture = json(JSON.parse(JSON.stringify(raw.capture).replaceAll(raw.data_directory, nextRoot)));
  raw.data_directory = nextRoot;
  envelope.normalized = normalize(raw.capture, nextRoot);
  compare(golden, copy);
});
test("null reset changing to omitted value fails parity", () => {
  const drift = changed((capture) => {
    const input = object(named(capture, "schema_cases", "quantity-null-reset").input);
    const decisions = input.decisions;
    assert(Array.isArray(decisions) && decisions.length === 1);
    delete object(decisions[0]).value;
  });
  assert.throws(() => compare(golden, drift));
});
test("receipt revision identity drift fails parity", () => {
  const drift = changed((capture) => {
    const response = object(named(capture, "route_cases", "bound-http-final-inclusion-and-quantity").response);
    object(response.receipt).revision_id = 999;
  });
  assert.throws(() => compare(golden, drift));
});
test("output enum drift fails parity", () => {
  const drift = changed((capture) => {
    object(named(capture, "schema_cases", "identity-open").input).state = "consumed";
  });
  assert.throws(() => compare(golden, drift));
});
test("revision digest drift fails parity", () => {
  const drift = changed((capture) => {
    const response = object(named(capture, "route_cases", "bound-http-final-inclusion-and-quantity").response);
    object(response.receipt).revision_digest = "f".repeat(64);
  });
  assert.throws(() => compare(golden, drift));
});
test("Required-unit token identity drift fails parity", () => {
  const drift = changed((capture) => {
    const states = object(capture.states);
    const state = Object.values(states)[0];
    assert(state);
    const units = object(object(state).database).required_units;
    assert(Array.isArray(units) && units.length > 0);
    object(units[0]).token = `ppu_${"f".repeat(32)}`;
  });
  assert.throws(() => compare(golden, drift));
});
test("nonempty historical Plate unit linkage drift fails parity", () => {
  const drift = changed((capture) => {
    const states = object(capture.states);
    const state = states[String(capture.final_state)];
    assert(state);
    const units = object(object(state).database).accepted_plate_units;
    assert(Array.isArray(units) && units.length > 0);
    object(units[0]).required_unit_token = `ppu_${"f".repeat(32)}`;
  });
  assert.throws(() => compare(golden, drift), /accepted_plate_units.*required_unit_token/);
});
test("historical Plate accepted-Plan linkage drift fails parity", () => {
  const drift = changed((capture) => {
    const state = object(capture.states)[String(capture.final_state)];
    assert(state);
    const revisions = object(object(state).database).accepted_plate_revisions;
    assert(Array.isArray(revisions) && revisions.length > 0);
    object(revisions[0]).plan_revision_id = 999;
  });
  assert.throws(() => compare(golden, drift), /accepted_plate_revisions.*plan_revision_id/);
});
test("snapshot rows are ordered by their complete declared keys", () => {
  const capture = object(object(golden).normalized);
  const ordering = object(capture.table_ordering);
  let observedPrefixTie = false;
  for (const [id, state] of Object.entries(object(capture.states))) {
    assert.equal(digest(canonical(state)), id, "Canonical state hash");
    for (const [table, rows] of Object.entries(object(object(state).database))) {
      assert(Array.isArray(rows));
      const columns = object(ordering[table]).columns;
      assert(Array.isArray(columns) && columns.every((column) => typeof column === "string"));
      const keys = rows.map((row) => columns.map((column) => {
        assert(typeof column === "string");
        return object(row)[column];
      }));
      for (let index = 1; index < keys.length; index += 1) {
        const previous = keys[index - 1];
        const current = keys[index];
        if (current.length > 2 && current[0] === previous[0] && current[1] === previous[1]) observedPrefixTie = true;
        let difference = 0;
        for (let column = 0; column < current.length; column += 1) {
          const a = previous[column];
          const b = current[column];
          if (a === b) continue;
          if (a === null) { difference = -1; break; }
          if (b === null) { difference = 1; break; }
          assert((typeof a === "string" && typeof b === "string") || (typeof a === "number" && typeof b === "number"));
          difference = a < b ? -1 : 1;
          break;
        }
        assert(difference < 0, `${table}: complete key order or uniqueness`);
      }
    }
  }
  assert(observedPrefixTie, "Fixture must exercise tied first-two-column prefixes");
});
test("reordering Required-unit rows with a tied prefix fails parity", () => {
  const drift = changed((capture) => {
    const state = object(capture.states)[String(capture.initial_state)];
    assert(state);
    const mappings = object(object(state).database).plan_revision_required_units;
    assert(Array.isArray(mappings) && mappings.length >= 2);
    assert.equal(object(mappings[0]).tenant_id, object(mappings[1]).tenant_id);
    assert.equal(object(mappings[0]).revision_id, object(mappings[1]).revision_id);
    [mappings[0], mappings[1]] = [mappings[1], mappings[0]];
  });
  assert.throws(() => compare(golden, drift), /plan_revision_required_units/);
});
test("publication count drift fails parity", () => {
  const drift = changed((capture) => {
    const states = object(capture.states);
    const state = Object.values(states)[0];
    assert(state);
    const revisions = object(object(state).database).plan_revisions;
    assert(Array.isArray(revisions) && revisions.length > 0);
    revisions.push(structuredClone(revisions[0]));
  });
  assert.throws(() => compare(golden, drift));
});
test("duplicated publication row fails parity against itself", () => {
  const corrupt = changed((capture) => {
    const states = object(capture.states);
    const state = Object.values(states)[0];
    assert(state);
    const revisions = object(object(state).database).plan_revisions;
    assert(Array.isArray(revisions) && revisions.length > 0);
    revisions.push(structuredClone(revisions[0]));
  });
  assert.throws(() => compare(corrupt, structuredClone(corrupt)), /State hash mismatch/);
});
test("route case pointing at a missing state fails parity against itself", () => {
  const corrupt = changed((capture) => {
    named(capture, "route_cases", "bound-http-final-inclusion-and-quantity").before = "f".repeat(64);
  });
  assert.throws(() => compare(corrupt, structuredClone(corrupt)), /route_cases\.bound-http-final-inclusion-and-quantity\.before/);
});
test("unreferenced database state fails parity against itself", () => {
  const copy = structuredClone(golden);
  const envelope = object(copy);
  const raw = object(envelope.raw);
  assert(typeof raw.data_directory === "string");
  const states = object(object(raw.capture).states);
  const state = structuredClone(Object.values(states)[0]);
  assert(state);
  const files = object(state).files;
  assert(Array.isArray(files) && files.length > 0);
  const file = object(files[0]);
  assert(typeof file.bytes === "number");
  file.bytes += 1;
  const id = digest(canonical(normalize(state, raw.data_directory)));
  states[id] = state;
  envelope.normalized = normalize(raw.capture, raw.data_directory);
  assert.throws(() => compare(copy, structuredClone(copy)), /Unreferenced state/);
});
test("no-write route with a different after state fails parity against itself", () => {
  const corrupt = changed((capture) => {
    const route = named(capture, "route_cases", "changed-payload-same-key");
    assert.equal(route.before, route.after);
    assert.notEqual(capture.initial_state, route.before);
    route.after = capture.initial_state;
  });
  assert.throws(
    () => compare(corrupt, structuredClone(corrupt)),
    /route_cases\.changed-payload-same-key: exact-database-and-file-no-write/,
  );
});
test("publication route with identical before and after states fails parity against itself", () => {
  const corrupt = changed((capture) => {
    const route = named(capture, "route_cases", "bound-http-final-inclusion-and-quantity");
    assert.notEqual(route.before, route.after);
    route.after = route.before;
  });
  assert.throws(
    () => compare(corrupt, structuredClone(corrupt)),
    /route_cases\.bound-http-final-inclusion-and-quantity: one-publication/,
  );
});
test("publication route whose after state still has a plate head fails parity against itself", () => {
  const corrupt = changed((capture) => {
    const route = named(capture, "route_cases", "bound-http-final-inclusion-and-quantity");
    const headed = named(capture, "setup_operations", "initial-accepted-plate").state;
    assert(typeof headed === "string" && headed !== route.before && headed !== route.after);
    const heads = object(object(object(capture.states)[headed]).database).accepted_plate_heads;
    const afterHeads = object(object(object(capture.states)[String(route.after)]).database).accepted_plate_heads;
    assert(Array.isArray(heads) && heads.length > 0);
    assert(Array.isArray(afterHeads) && afterHeads.length === 0);
    route.after = headed;
  });
  assert.throws(
    () => compare(corrupt, structuredClone(corrupt)),
    /route_cases\.bound-http-final-inclusion-and-quantity: current-plate-head-invalidated/,
  );
});
test("file digest drift fails parity against itself", () => {
  const corrupt = changed((capture) => {
    const states = object(capture.states);
    const state = Object.values(states)[0];
    assert(state);
    const files = object(state).files;
    assert(Array.isArray(files) && files.length > 0);
    object(files[0]).sha256 = "f".repeat(64);
  });
  assert.throws(() => compare(corrupt, structuredClone(corrupt)), /State hash mismatch/);
});
test("raw drift cannot hide behind unchanged normalized evidence", () => {
  const copy = structuredClone(golden);
  object(object(copy).raw).capture = null;
  assert.throws(() => compare(golden, copy), /Raw and normalized evidence differ/);
});

function changedRouteFiles(endpoint: "before" | "after", update: (state: { [key: string]: Json }) => void): Json {
  const copy = structuredClone(golden);
  const envelope = object(copy);
  const raw = object(envelope.raw);
  assert(typeof raw.data_directory === "string");
  const capture = object(raw.capture);
  const states = object(capture.states);
  const route = named(capture, "route_cases", "bound-http-final-inclusion-and-quantity");
  const previous = route[endpoint];
  assert(typeof previous === "string");
  const state = object(states[previous]);
  update(state);
  const next = digest(canonical(normalize(state, raw.data_directory)));
  delete states[previous];
  states[next] = state;
  for (const key of ["initial_state", "final_state"]) {
    if (capture[key] === previous) capture[key] = next;
  }
  for (const { collection, keys } of [
    { collection: "setup_operations", keys: ["state"] },
    { collection: "route_cases", keys: ["before", "after"] },
  ]) {
    const entries = capture[collection];
    assert(Array.isArray(entries));
    for (const entry of entries) {
      const record = object(entry);
      for (const key of keys) {
        if (record[key] === previous) record[key] = next;
      }
    }
  }
  envelope.normalized = normalize(raw.capture, raw.data_directory);
  return copy;
}

const fileChanges: { name: string; update: (files: Json[]) => void }[] = [
  { name: "digest", update: (files) => { object(files[0]).sha256 = "f".repeat(64); } },
  { name: "byte count", update: (files) => {
    const file = object(files[0]);
    assert(typeof file.bytes === "number");
    file.bytes += 1;
  } },
  { name: "path", update: (files) => { object(files[0]).path = "$DATA/changed.stl"; } },
  { name: "addition", update: (files) => { files.push(structuredClone(files[0])); } },
  { name: "removal", update: (files) => { files.pop(); } },
  { name: "reorder", update: (files) => {
    assert(files.length >= 2);
    [files[0], files[1]] = [files[1], files[0]];
  } },
];
for (const { name, update } of fileChanges) {
  test(`rehashed publication file ${name} fails parity against itself`, () => {
    const corrupt = changedRouteFiles("after", (state) => {
      const files = state.files;
      assert(Array.isArray(files) && files.length > 0);
      update(files);
    });
    assert.throws(
      () => compare(corrupt, structuredClone(corrupt)),
      /route_cases\.bound-http-final-inclusion-and-quantity: fixture-file-hashes-unchanged/,
    );
  });
}
for (const endpoint of ["before", "after"] satisfies ("before" | "after")[]) {
  test(`rehashed publication with malformed ${endpoint} files fails parity against itself`, () => {
    const corrupt = changedRouteFiles(endpoint, (state) => { state.files = null; });
    assert.throws(
      () => compare(corrupt, structuredClone(corrupt)),
      /route_cases\.bound-http-final-inclusion-and-quantity: fixture-file-hashes-unchanged/,
    );
  });
}
