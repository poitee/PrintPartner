// Generates the gcode-object parity goldens from the TypeScript parser and the
// Rust comparison-key table. Run from the repo root:
//   node fixtures/parity/gcode-objects/generate.mjs          # write
//   node fixtures/parity/gcode-objects/generate.mjs --check  # verify, no writes
// Needs Node >= 22.18 (built-in type stripping); no npm install required.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const parserSource = "web/apps/server/src/services/gcode-object-parser.ts";
const matcherSource = "web/packages/domain/src/sliced-object-matching.ts";
const keyTablePath = join(root, "rust/crates/pp-domain/src/gcode_objects/key_table.rs");
const check = process.argv.includes("--check");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@print-partner/domain") {
      return { url: pathToFileURL(join(root, matcherSource)).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { groupObjectsByPart, matchObjectsToFilenames } = await import(
  pathToFileURL(join(root, parserSource)).href
);

// Cases 1-4 mirror gcode-object-parser.test.ts; `testExpect` is the expectation
// asserted there and is re-asserted here before the golden is written.
const cases = [
  {
    id: "test-unit-suffixes",
    origin: "test: matches generated unit suffixes to the source STL",
    names: ["z_alignment_tool_rear_01", "z_alignment_tool_rear_02"],
    libraryFilenames: ["z_alignment_tool_rear.stl"],
    testExpect: [
      ["z_alignment_tool_rear_01", ["z_alignment_tool_rear.stl"]],
      ["z_alignment_tool_rear_02", ["z_alignment_tool_rear.stl"]],
    ],
  },
  {
    id: "test-sliced-filename",
    origin: "test: matches a sliced filename to the corresponding source STL",
    names: ["cable_frame_anchor.bgcode"],
    libraryFilenames: ["cable_frame_anchor.stl"],
    testExpect: [["cable_frame_anchor.bgcode", ["cable_frame_anchor.stl"]]],
  },
  {
    id: "test-fuzzy-matcher",
    origin: "test: uses the shared conservative fuzzy matcher",
    names: ["z_tensionr_left.stl"],
    libraryFilenames: ["z_tensioner_left.stl", "z_tensioner_right.stl"],
    testExpect: [["z_tensionr_left.stl", ["z_tensioner_left.stl"]]],
  },
  {
    id: "test-duplicate-basenames",
    origin: "test: returns all duplicate basename candidates instead of guessing",
    names: ["bracket.stl"],
    libraryFilenames: ["kit-a/bracket.stl", "kit-b/bracket.stl"],
    testExpect: [["bracket.stl", ["kit-a/bracket.stl", "kit-b/bracket.stl"]]],
  },
  {
    id: "edge-no-objects",
    origin: "edge: no objects on the plate",
    names: [],
    libraryFilenames: ["bracket.stl", "z_tensioner_left.stl"],
  },
  {
    id: "edge-duplicate-names",
    origin: "edge: duplicate and case-variant object names",
    names: [
      "bracket.stl_id_0_copy_0",
      "bracket.stl_id_0_copy_0",
      "Bracket.STL_id_1_copy_1",
      "'bracket_stl'",
      "'bracket_stl__Instance_2_'",
      "bracket.stl (Instance 3)",
      "bracket_stl",
      "bracket_stl",
    ],
    libraryFilenames: ["bracket.stl", "parts/Bracket.stl", "bracket_holder.stl"],
  },
  {
    id: "edge-stem-nn",
    origin: "edge: stem_NN generated unit suffixes",
    names: [
      "frame_corner_1",
      "frame_corner_01",
      "frame_corner_007",
      "frame_corner_1234",
      "frame_corner_02.stl_id_3_copy_1",
      "'frame_corner_03_stl'",
      "idler_12",
      "_42",
    ],
    libraryFilenames: ["frame_corner.stl", "idler.stl", "idler_12.stl", "42.stl"],
  },
  {
    id: "edge-unicode-names",
    origin: "edge: unicode, percent-encoded and compatibility-form names",
    names: [
      "Halterung_für_Rohr.stl_id_0_copy_0",
      "Halterung_f%C3%BCr_Rohr.stl",
      "'CAFÉ_lid_stl'",
      "ＢＲＡＣＫＥＴ.stl",
      "支架_左.stl",
      "ΣΊΣΥΦΟΣ_mount.stl",
      "İstanbul_plate.stl (Instance 2)",
      "ﬁlament_guide_①.stl",
      "😀 fan duct.3mf",
      "naïve\u00a0cover.stl",
    ],
    libraryFilenames: [
      "Halterung_fur_Rohr.stl",
      "cafe_lid.stl",
      "bracket.stl",
      "支架_右.stl",
      "σίσυφος_mount.stl",
      "istanbul_plate.stl",
      "filament_guide_1.stl",
      "fan_duct.stl",
      "naive_cover.stl",
    ],
  },
  {
    id: "edge-truncated-file",
    origin: "edge: names cut off mid-line by a truncated gcode file",
    names: [
      "'spool_holder_stl",
      "spool_holder.stl_id_0_copy_",
      "spool_holder.stl_id_0_cop",
      "spool_holder.stl (Instance 2",
      "'spool_holder_stl__Instance_",
      "spool_holder_f%C3",
      "spool_holder.st",
      "'",
      "",
    ],
    libraryFilenames: ["spool_holder.stl", "spool_holder_foot.stl"],
  },
  {
    id: "extra-slicer-formats",
    origin: "extra: one name per slicer wrapper, with paths and extension stacks",
    names: [
      "a_drive_frame_lower.stl_id_0_copy_0",
      "a_drive_frame_lower.stl_id_0_copy_1",
      "'a_drive_frame_upper_stl'",
      "'a_drive_frame_upper_stl__Instance_1_'",
      "\"x_carriage.stl\"",
      "x_carriage.stl (instance 2)",
      "tool_head_stl",
      "  padded_part.STL  ",
      "kit-a\\sub\\bracket.stl.gcode",
      "kit-b/bracket.3mf.bgcode",
      "part.stl_id_1_copy_99999999999999999999",
      "line\nbreak.stl_id_0_copy_2",
    ],
    libraryFilenames: [
      "a_drive_frame_lower.stl",
      "a_drive_frame_upper.stl",
      "x_carriage.stl",
      "tool_head.stl",
      "padded_part.stl",
      "kit-a/sub/bracket.stl",
      "kit-b/bracket.stl",
      "part.stl",
    ],
  },
  {
    id: "extra-fuzzy-ambiguous",
    origin: "extra: fuzzy near-ties, semantic guards and unmatched names",
    names: [
      "extruder_mount_b",
      "z_tensionr_left.stl",
      "z_tensioner_rght.stl",
      "spacer_m3x10",
      "lid",
      "Belt-Clamp",
    ],
    libraryFilenames: [
      "extruder_mount_a.stl",
      "extruder_mount_c.stl",
      "Extruder_Mount_D.stl",
      "z_tensioner_left.stl",
      "z_tensioner_right.stl",
      "spacer_m3x12.stl",
      "lid.stl",
      "belt_clamp.stl",
      "belt-clamp.stl",
    ],
  },
];

function run(testCase) {
  const grouped = groupObjectsByPart(testCase.names);
  const matches = matchObjectsToFilenames(grouped, testCase.libraryFilenames);
  if (testCase.testExpect) assert.deepStrictEqual(matches, new Map(testCase.testExpect));
  return {
    groups: [...grouped].map(([key, plate]) => ({ key, ...plate })),
    matches: [...matches].map(([key, filenames]) => ({ key, filenames })),
  };
}

const outputs = new Map();
for (const testCase of cases) {
  const golden = {
    source: [parserSource, matcherSource],
    origin: testCase.origin,
    input: { names: testCase.names, libraryFilenames: testCase.libraryFilenames },
    expected: run(testCase),
  };
  outputs.set(join(here, `${testCase.id}.json`), `${JSON.stringify(golden, null, 2)}\n`);
}
outputs.set(keyTablePath, keyTable());

const stale = readdirSync(here)
  .filter((name) => name.endsWith(".json"))
  .map((name) => join(here, name))
  .filter((path) => !outputs.has(path));
const drift = [];
for (const path of stale) {
  if (check) drift.push(`unexpected ${relative(root, path)}`);
  else unlinkSync(path);
}
for (const [path, text] of outputs) {
  let current = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (current === text) continue;
  if (check) drift.push(`out of date ${relative(root, path)}`);
  else writeFileSync(path, text);
}
if (drift.length) {
  console.error(drift.join("\n"));
  process.exit(1);
}
console.log(JSON.stringify({ cases: cases.length, testFileCases: cases.filter((c) => c.testExpect).length, check }));

// The TS comparison key is NFKD -> strip U+0300..U+036F -> lowercase -> runs
// of [^a-z0-9] become "_". Applied per code point, every non-ASCII char
// becomes "_" unless listed here, so Rust needs only this exception table.
function keyTable() {
  const segment = (value) =>
    value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const rows = [];
  for (let cp = 0x80; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const key = segment(String.fromCodePoint(cp));
    if (key !== "_") rows.push(`    (0x${cp.toString(16).toUpperCase().padStart(4, "0")}, ${JSON.stringify(key)}),`);
  }
  return [
    `// @generated by fixtures/parity/gcode-objects/generate.mjs from Node ${process.version}`,
    `// (ICU ${process.versions.icu}, Unicode ${process.versions.unicode}). Do not edit.`,
    "//",
    "// Non-ASCII code points whose comparison key is not a lone \"_\": the result of",
    "// NFKD, dropping U+0300..U+036F, lowercasing and mapping [^a-z0-9] to \"_\".",
    "pub(super) const KEY_EXCEPTIONS: &[(u32, &str)] = &[",
    ...rows,
    "];",
    "",
  ].join("\n");
}
