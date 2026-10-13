// Usage: node source-path-replay.mjs <local-source-snapshot.js> <corpus.json> <report.json>
// Every raw mismatch is retained. Exit 1 on a new difference, a validator
// regression, or a Rust/Node Unicode version difference; documented Rust-only
// rules remain visible.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
  {
    id: 'colon',
    test: (p) => p.includes(':'),
    documented: 'rust/crates/pp-source/README.md (no colon: Windows drive and ADS safety)',
  },
  {
    id: 'manifest-first-directory',
    test: (p, manifest) => p.split('/')[0] === manifest && p !== manifest,
    documented: 'rust/crates/pp-source/README.md (reserved manifest name as first component)',
  },
];

// Independent shared-contract model. NFC is evaluated separately using each
// runtime's normalized spelling, including when a Rust-only rule also fails.
function sharedStructureAccepts(path, manifest) {
  return path.length > 0 && !path.includes('\\') && !path.includes('\0') && path !== manifest
    && path.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}

// Node reports "major.minor"; unicode-normalization reports (major, minor, patch).
function unicodeVersionsMatch(rustVersion, nodeVersion = process.versions.unicode) {
  const [major, minor = 0, patch = 0] = nodeVersion.split('.').map(Number);
  return rustVersion[0] === major && rustVersion[1] === minor && rustVersion[2] === patch;
}

export function replayCorpus(corpus, sourceRelativePath, manifest) {
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0
      || !Number.isInteger(corpus.generated) || corpus.generated < 0
      || !Array.isArray(corpus.rust_unicode_version) || corpus.rust_unicode_version.length !== 3) {
    throw new Error('Invalid or empty SourcePath corpus');
  }
  const byRule = Object.fromEntries(rustOnlyRules.map(({ id, documented }) => [id, { count: 0, documented }]));
  const mismatchCases = [];
  const normalizationCases = [];
  const unexpectedCases = [];
  let rustAccept = 0;
  let nodeAccept = 0;
  let generated = 0;
  let knownRustStricter = 0;

  for (const [index, {
    path, origin, rustAccepts, rustReferenceAccepts, rustNfc, rustFixtureAccepts, rustFixtureNfc,
  }] of corpus.cases.entries()) {
    if (typeof path !== 'string' || typeof rustNfc !== 'string' || typeof rustAccepts !== 'boolean'
        || typeof rustReferenceAccepts !== 'boolean'
        || !['fixture', 'generated'].includes(origin)) {
      throw new Error('Invalid SourcePath case ' + index);
    }
    generated += origin === 'generated' ? 1 : 0;
    let nodeAccepts = false;
    try {
      sourceRelativePath(path);
      nodeAccepts = true;
    } catch {
      // The production parser signals rejection by throwing.
    }
    rustAccept += rustAccepts ? 1 : 0;
    nodeAccept += nodeAccepts ? 1 : 0;
    const nodeNfc = path.normalize('NFC');
    const structureAccepts = sharedStructureAccepts(path, manifest);
    const rustSharedAccepts = structureAccepts && rustNfc === path;
    const nodeSharedAccepts = structureAccepts && nodeNfc === path;
    const rules = rustOnlyRules.filter((r) => r.test(path, manifest)).map((r) => r.id);
    const expectedRust = rustSharedAccepts && rules.length === 0;
    const errors = [];
    if (rustAccepts !== rustReferenceAccepts) errors.push('Rust decision differs from its reference model');
    if (rustReferenceAccepts !== expectedRust) errors.push('Rust reference differs from its contract model');
    if (rustFixtureAccepts !== undefined && rustAccepts !== rustFixtureAccepts) errors.push('Rust decision differs from fixture');
    if (rustFixtureNfc !== undefined && rustNfc !== rustFixtureNfc) errors.push('Rust NFC differs from fixture');
    if (nodeAccepts !== nodeSharedAccepts) errors.push('Node decision differs from its shared contract model');
    if (rustNfc !== nodeNfc) errors.push('Unclassified NFC difference');

    let classification = 'agree';
    if (rustAccepts !== nodeAccepts && errors.length === 0) {
      if (nodeAccepts && !rustAccepts && rustSharedAccepts && rules.length > 0) {
        classification = 'known-rust-stricter';
        knownRustStricter += 1;
        for (const rule of rules) byRule[rule].count += 1;
      } else {
        errors.push('Unclassified accept/reject mismatch');
      }
    }
    if (errors.length > 0) classification = 'unexpected';
    const record = {
      index, path, origin, rustAccepts, rustReferenceAccepts, nodeAccepts, rustSharedAccepts, nodeSharedAccepts,
      rustFixtureAccepts, rustFixtureNfc,
      rustNfc, nodeNfc, rustOnlyRules: rules, classification, errors,
      normalizationClassification: rustNfc === nodeNfc ? 'agree' : 'unexpected',
    };
    if (rustAccepts !== nodeAccepts) mismatchCases.push(record);
    if (rustNfc !== nodeNfc) normalizationCases.push(record);
    if (errors.length > 0) unexpectedCases.push(record);
  }
  if (generated !== corpus.generated) throw new Error('SourcePath generated count does not match corpus');
  return {
    seed: corpus.seed,
    rustUnicodeVersion: corpus.rust_unicode_version,
    nodeVersion: process.version,
    nodeUnicodeVersion: process.versions.unicode,
    unicodeVersionsMatch: unicodeVersionsMatch(corpus.rust_unicode_version),
    cases: corpus.cases.length,
    fixtures: corpus.cases.length - generated,
    generated,
    rustAccept, nodeAccept,
    agree: corpus.cases.length - mismatchCases.length,
    mismatches: mismatchCases.length,
    knownRustStricter,
    normalizationDifferences: normalizationCases.length,
    unexpectedMismatches: unexpectedCases.length,
    rustOnlyRules: byRule,
    mismatchCases, normalizationCases, unexpectedCases,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [snapshotModule, corpusPath, reportPath] = process.argv.slice(2);
  const { sourceRelativePath, SOURCE_SNAPSHOT_MANIFEST_FILE } = await import(pathToFileURL(snapshotModule));
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const report = replayCorpus(corpus, sourceRelativePath, SOURCE_SNAPSHOT_MANIFEST_FILE);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const { mismatchCases, normalizationCases, unexpectedCases, rustOnlyRules: _, ...summary } = report;
  console.log(JSON.stringify(summary));
  for (const [id, { count, documented }] of Object.entries(report.rustOnlyRules)) {
    console.log('rust-only rule ' + id + ': ' + count + ' case(s); ' + documented);
  }
  if (report.mismatches > 0) console.log('Documented Rust-only differences are retained in ' + reportPath);
  if (!report.unicodeVersionsMatch) {
    console.error('Rust Unicode ' + report.rustUnicodeVersion.join('.') + ' differs from Node Unicode '
      + report.nodeUnicodeVersion + '; align unicode-normalization with the pinned Node version');
    process.exitCode = 1;
  }
  if (unexpectedCases.length > 0) {
    console.error(JSON.stringify(unexpectedCases.slice(0, 5), null, 2));
    process.exitCode = 1;
  }
}
