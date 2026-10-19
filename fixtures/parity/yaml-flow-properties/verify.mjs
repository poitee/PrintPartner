import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate, goldenPath, serialize } from "./generate.mjs";

const literals = [
  ["explicit-empty", "flow-explicit-key", "[? ]", { kind: "decoded", value: [{ null: null }] }],
  ["tag-adjacent", "verbatim-tag-adjacency", "!<tag:yaml.org,2002:str>b c1", { kind: "decoded", value: "b c1" }],
  ["implicit-sequence", "flow-empty-key", "[:[]]", { kind: "decoded", value: [{ null: [] }] }],
  ["implicit-map-tab", "flow-empty-key", "{:\ta\n }", { kind: "decoded", value: { null: "a" } }],
  ["block-colon", "block-colon-after-flow", "a:\n  []\n\n: ]", { kind: "decoded", value: { a: [], null: "]" } }],
  ["quoted-tab", "quoted-multiline-flow-key-tab", 'a:\n  {"a\n b":\ta\\}', { kind: "decoded", value: { a: { "a b": "a\\" } } }],
  ["comment-adjacent", "comment-after-key-colon", '{"q":# c\n}', {
    kind: "refused", class: "YAMLException", reason: "missed comma between flow collection entries",
  }],
  ["null-one-key", "one-key-null-control", '{"q":}', { kind: "decoded", value: { q: null } }],
  ["comment-separated", "comment-after-key-colon", '{"q": # c\n}', { kind: "decoded", value: { q: null } }],
];

function verifyLiterals(corpus) {
  const expected = literals.flatMap(([name, family, text, outcome]) => {
    const variants = text.includes("\n") ? ["lf", "cr", "crlf"] : ["none", "lf", "cr", "crlf"];
    return variants.map((variant) => {
      const ending = { none: "", lf: "\n", cr: "\r", crlf: "\r\n" }[variant];
      const input = text.includes("\n") ? text.split("\n").join(ending) : text + ending;
      return { id: `${name}-${variant}`, family, variant, input, utf8Hex: Buffer.from(input, "utf8").toString("hex"), outcome };
    });
  });
  assert.deepEqual(corpus.cases, expected, "literal corpus mismatch");
}

function verify(path) {
  const bytes = readFileSync(path, "utf8");
  const stored = JSON.parse(bytes);
  verifyLiterals(stored);
  const actual = generate();
  verifyLiterals(actual);
  assert.equal(bytes, serialize(actual), "Fixture bytes or source metadata differ from the real repository js-yaml run");
  return stored.cases.length;
}

function selfTest() {
  const script = fileURLToPath(import.meta.url);
  test("standalone verifier accepts all 31 literal outcomes", () => {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified 31 literal YAML outcomes/);
  });
  const mutations = [
    ["changed decoded result", (corpus) => { corpus.cases[0].outcome.value = [{ null: "changed" }]; }],
    ["changed one-key null semantics", (corpus) => {
      corpus.cases.find((entry) => entry.id === "null-one-key-none").outcome.value = {};
    }],
    ["changed refusal class", (corpus) => {
      corpus.cases.find((entry) => entry.id === "comment-adjacent-lf").outcome.class = "Error";
    }],
    ["changed refusal reason", (corpus) => {
      corpus.cases.find((entry) => entry.id === "comment-adjacent-lf").outcome.reason = "changed";
    }],
    ["changed source bytes", (corpus) => { corpus.cases[0].utf8Hex = "00"; }],
    ["missing corpus case", (corpus) => { corpus.cases.pop(); }],
  ];
  for (const [name, mutate] of mutations) {
    test(`standalone verifier rejects ${name}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "gre-871-"));
      try {
        const corpus = JSON.parse(readFileSync(goldenPath, "utf8"));
        mutate(corpus);
        const path = join(directory, "changed.json");
        writeFileSync(path, serialize(corpus));
        const result = spawnSync(process.execPath, [script, path], { encoding: "utf8" });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /literal corpus mismatch/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

assert(process.argv.length <= 3, "Usage: node verify.mjs [--self-test | fixture-path]");
if (process.argv[2] === "--self-test") {
  verify(goldenPath);
  selfTest();
} else {
  const count = verify(process.argv[2] ?? goldenPath);
  console.log(`Verified ${count} literal YAML outcomes against repository js-yaml 5.4.3. Rust parity is not asserted.`);
}
