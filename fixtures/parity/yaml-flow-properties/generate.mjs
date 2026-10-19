import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../../web/apps/server/package.json", import.meta.url));
const yaml = require("js-yaml");
const { version } = require("js-yaml/package.json");
export const goldenPath = fileURLToPath(new URL("node.json", import.meta.url));

const seeds = [
  ["explicit-empty", "flow-explicit-key", "[? ]"],
  ["tag-adjacent", "verbatim-tag-adjacency", "!<tag:yaml.org,2002:str>b c1"],
  ["implicit-sequence", "flow-empty-key", "[:[]]"],
  ["implicit-map-tab", "flow-empty-key", "{:\ta\n }"],
  ["block-colon", "block-colon-after-flow", "a:\n  []\n\n: ]"],
  ["quoted-tab", "quoted-multiline-flow-key-tab", 'a:\n  {"a\n b":\ta\\}'],
  ["comment-adjacent", "comment-after-key-colon", '{"q":# c\n}'],
  ["null-one-key", "one-key-null-control", '{"q":}'],
  ["comment-separated", "comment-after-key-colon", '{"q": # c\n}'],
];

export function generate() {
  assert.equal(process.versions.node.split(".")[0], "22", "Run with Node 22");
  assert.equal(version, "5.4.3", "Review literal outcomes before changing js-yaml versions");
  const cases = seeds.flatMap(([name, family, text]) => {
    const endings = text.includes("\n")
      ? [["lf", "\n"], ["cr", "\r"], ["crlf", "\r\n"]]
      : [["none", ""], ["lf", "\n"], ["cr", "\r"], ["crlf", "\r\n"]];
    return endings.map(([variant, ending]) => {
      const input = text.includes("\n") ? text.replaceAll("\n", ending) : text + ending;
      let outcome;
      try {
        outcome = { kind: "decoded", value: yaml.load(input) };
      } catch (error) {
        if (!(error instanceof yaml.YAMLException)) throw error;
        outcome = { kind: "refused", class: error.name, reason: error.reason };
      }
      return { id: `${name}-${variant}`, family, variant, input, utf8Hex: Buffer.from(input).toString("hex"), outcome };
    });
  });
  return {
    format: "yaml-flow-properties-node-v1",
    source: {
      issue: "GRE-871",
      parent: "GRE-841",
      parentUrl: "https://linear.app/greetz/issue/GRE-841/p2-working-draft-yaml-remaining-flow-key-and-verbatim-tag-parity-gaps",
      generator: "fixtures/parity/yaml-flow-properties/generate.mjs",
      dependencyAnchor: "web/apps/server/package.json",
      package: "js-yaml",
      version,
      api: "yaml.load(input)",
      options: "defaults",
      nodeMajor: 22,
      encoding: "UTF-8",
      rustParity: "not asserted",
    },
    cases,
  };
}

export function serialize(corpus) {
  return `${JSON.stringify(corpus, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--check"), "Usage: node generate.mjs [--check]");
  const corpus = generate();
  const bytes = serialize(corpus);
  if (process.argv[2] === "--check") {
    assert.equal(readFileSync(goldenPath, "utf8"), bytes, "node.json differs from repository js-yaml outcomes");
    console.log(`Checked deterministic Node outcomes for ${corpus.cases.length} YAML cases.`);
  } else {
    writeFileSync(goldenPath, bytes);
    console.log(`Recorded ${corpus.cases.length} YAML cases in ${goldenPath}.`);
  }
}
