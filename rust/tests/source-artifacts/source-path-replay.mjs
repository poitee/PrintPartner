// Replays the Rust SourcePath corpus through Node's sourceRelativePath and
// compares accept/reject decisions.
//
// Usage: node source-path-replay.mjs <local-source-snapshot.js> <corpus.json> <report.json>
// Exits 1 on any mismatch that no rule below explains.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [snapshotModule, corpusPath, reportPath] = process.argv.slice(2);
const { sourceRelativePath, SOURCE_SNAPSHOT_MANIFEST_FILE } = await import(pathToFileURL(snapshotModule));
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

// Rules Rust enforces in SourcePath that Node's sourceRelativePath does not.
// A mismatch is explained only when Node accepts, Rust rejects, and at least
// one rule matches. `documented` points at where the stricter rule is stated.
const rustOnlyRules = [
  {
    id: 'utf8-byte-bound',
    test: (p) => Buffer.byteLength(p, 'utf8') > 4096,
    documented: 'rust/crates/pp-source/README.md (4,096 UTF-8 path bytes)',
  },
  {
    id: 'component-bound',
    test: (p) => p.split('/').length > 64,
    documented: 'rust/crates/pp-source/README.md (64 path components)',
  },
  { id: 'colon', test: (p) => p.includes(':'), documented: null },
  {
    id: 'manifest-first-directory',
    test: (p) => p.split('/')[0] === SOURCE_SNAPSHOT_MANIFEST_FILE && p !== SOURCE_SNAPSHOT_MANIFEST_FILE,
    documented: null,
  },
];

const nodeAccepts = (path) => {
  try {
    sourceRelativePath(path);
    return true;
  } catch {
    return false;
  }
};

let agree = 0;
const byRule = Object.fromEntries(rustOnlyRules.map((r) => [r.id, { count: 0, documented: r.documented, examples: [] }]));
const unexplained = [];
const totals = { rustAccept: 0, nodeAccept: 0 };
for (const { path, origin, rustAccepts } of corpus.cases) {
  const node = nodeAccepts(path);
  totals.rustAccept += rustAccepts ? 1 : 0;
  totals.nodeAccept += node ? 1 : 0;
  if (node === rustAccepts) {
    agree += 1;
    continue;
  }
  const rules = node && !rustAccepts ? rustOnlyRules.filter((r) => r.test(path)) : [];
  if (rules.length === 0) {
    unexplained.push({ path, origin, rustAccepts, nodeAccepts: node });
    continue;
  }
  for (const rule of rules) {
    const entry = byRule[rule.id];
    entry.count += 1;
    if (entry.examples.length < 3) entry.examples.push(path.length > 120 ? `${path.slice(0, 120)}…` : path);
  }
}

const mismatches = corpus.cases.length - agree;
const report = {
  seed: corpus.seed,
  cases: corpus.cases.length,
  fixtures: corpus.cases.length - corpus.generated,
  generated: corpus.generated,
  ...totals,
  agree,
  mismatches,
  explainedRustStricter: mismatches - unexplained.length,
  unexplained: unexplained.length,
  rustOnlyRules: byRule,
  unexplainedCases: unexplained.slice(0, 50),
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const { unexplainedCases, rustOnlyRules: _, ...summary } = report;
console.log(JSON.stringify(summary));
for (const [id, { count, documented }] of Object.entries(byRule)) {
  console.log(`rust-only rule ${id}: ${count} case(s); ${documented ? `documented in ${documented}` : 'UNDOCUMENTED'}`);
}
if (unexplained.length > 0) {
  console.error(JSON.stringify(unexplainedCases, null, 2));
  process.exitCode = 1;
}
