import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sourceRelativePath, SOURCE_SNAPSHOT_MANIFEST_FILE as manifest }
  from '../../../web/apps/server/dist/current/services/local-source-snapshot.js';
import { replayCorpus } from './source-path-replay.mjs';

const corpusOf = (...cases) => ({
  seed: 'regression', generated: 0, rust_unicode_version: [17, 0, 0],
  cases: cases.map((c) => ({ origin: 'fixture', rustReferenceAccepts: c.rustAccepts, ...c })),
});
const run = (corpus, validator = sourceRelativePath) => replayCorpus(corpus, validator, manifest);

test('colon difference is retained with the complete path and documented rule', () => {
  const report = run(corpusOf({ path: 'a:b.stl', rustNfc: 'a:b.stl', rustAccepts: false }));
  assert.equal(report.mismatches, 1);
  assert.equal(report.knownRustStricter, 1);
  assert.equal(report.unexpectedMismatches, 0);
  assert.equal(report.mismatchCases[0].path, 'a:b.stl');
  assert.deepEqual(report.mismatchCases[0].rustOnlyRules, ['colon']);
  assert.match(report.rustOnlyRules.colon.documented, /pp-source\/README\.md/);
});

test('a colon cannot excuse a Node parser that silently normalizes NFD', () => {
  const report = run(corpusOf({ path: 'a\u0301:.stl', rustNfc: '\u00e1:.stl', rustAccepts: false }),
    (p) => sourceRelativePath(p.normalize('NFC')));
  assert.equal(report.mismatches, 1);
  assert.equal(report.knownRustStricter, 0);
  assert.equal(report.unexpectedMismatches, 1);
  assert.equal(report.mismatchCases[0].nodeSharedAccepts, false);
});

test('Unicode 16 drift fails even when a colon makes both parsers reject', () => {
  // Unicode 16 treated U+1ADD as a starter, so NFC left these spellings unchanged.
  const plain = 'a\u1add\u0300.stl';
  const colon = 'a\u1add\u0300:.stl';
  const report = run({
    ...corpusOf(
      { path: plain, rustNfc: plain, rustAccepts: true },
      { path: colon, rustNfc: colon, rustAccepts: false },
    ),
    rust_unicode_version: [16, 0, 0],
  });
  assert.equal(report.unicodeVersionsMatch, false);
  assert.equal(report.mismatches, 1);
  assert.equal(report.normalizationDifferences, 2);
  assert.equal(report.unexpectedMismatches, 2);
  assert.ok(report.unexpectedCases.every((c) => c.errors.includes('Unclassified NFC difference')));
  assert.equal(report.normalizationCases[1].path, colon);
  assert.equal(report.normalizationCases[1].rustSharedAccepts, true);
  assert.equal(report.normalizationCases[1].nodeSharedAccepts, false);
});

test('a Unicode reordering difference is not excused by a colon', () => {
  const path = 'a\u1add\u0303:.stl';
  const report = run(corpusOf({ path, rustNfc: path, rustAccepts: false }));
  assert.equal(report.mismatches, 0);
  assert.equal(report.normalizationDifferences, 1);
  assert.equal(report.unexpectedMismatches, 1);
  assert.deepEqual(report.unexpectedCases[0].errors, ['Unclassified NFC difference']);
});

test('a Rust-only exception cannot excuse traversal accepted by a faulty Node parser', () => {
  const path = '../a:b.stl';
  const report = run(corpusOf({ path, rustNfc: path, rustAccepts: false }), (p) => p);
  assert.equal(report.unexpectedMismatches, 1);
  assert.equal(report.knownRustStricter, 0);
});

test('all bound mismatches retain exact inputs and classifications', () => {
  const paths = Array.from({ length: 5 }, (_, i) => 'x'.repeat(4097 + i));
  const report = run(corpusOf(...paths.map((path) => ({ path, rustNfc: path, rustAccepts: false }))));
  assert.equal(report.mismatches, 5);
  assert.equal(report.unexpectedMismatches, 0);
  assert.deepEqual(report.mismatchCases.map((c) => c.path), paths);
  assert.ok(report.mismatchCases.every((c) => c.origin === 'fixture'
    && c.classification === 'known-rust-stricter' && !c.rustAccepts && c.nodeAccepts));
});

test('all Unicode 16-to-17 probes agree between Rust and Node', () => {
  const fixtures = JSON.parse(readFileSync(new URL(
    '../../crates/pp-source/tests/fixtures/source-path-unicode-16-17.json', import.meta.url,
  ), 'utf8'));
  assert.equal(fixtures.length, 408);
  const report = run(corpusOf(...fixtures.map((c) => ({ ...c, rustAccepts: c.accept }))));
  assert.equal(report.unicodeVersionsMatch, true);
  assert.equal(report.mismatches, 0);
  assert.equal(report.normalizationDifferences, 0);
  assert.equal(report.unexpectedMismatches, 0);
  for (const fixture of fixtures) {
    assert.equal(fixture.path.normalize('NFC'), fixture.nodeNfc, fixture.path);
    assert.equal(fixture.rustNfc, fixture.nodeNfc, fixture.path);
    assert.equal(fixture.accept, fixture.nodeAccept, fixture.path);
  }
});

test('the CLI exits 1 when Rust and Node Unicode versions differ', () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-path-version-'));
  try {
    const corpusPath = join(directory, 'corpus.json');
    const reportPath = join(directory, 'report.json');
    writeFileSync(corpusPath, JSON.stringify({
      ...corpusOf({ path: 'part.stl', rustNfc: 'part.stl', rustAccepts: true }),
      rust_unicode_version: [16, 0, 0],
    }));
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./source-path-replay.mjs', import.meta.url)),
      fileURLToPath(new URL('../../../web/apps/server/dist/current/services/local-source-snapshot.js', import.meta.url)),
      corpusPath, reportPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Rust Unicode 16\.0\.0 differs from Node Unicode/);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.unexpectedMismatches, 0);
    assert.equal(report.unicodeVersionsMatch, false);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('producer-to-replay preserves evidence for a Rust verdict/reference disagreement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-path-producer-'));
  try {
    const binary = process.env.PP_SOURCE_PATH_CORPUS_BINARY
      ?? fileURLToPath(new URL('../../target/debug/examples/source_path_corpus', import.meta.url));
    const produced = spawnSync(binary, ['--cases', '0', '--test-reject', 'part.stl'], { encoding: 'utf8' });
    assert.equal(produced.status, 0, produced.stderr);
    const corpus = JSON.parse(produced.stdout);
    assert.equal(corpus.regression_reject, 'part.stl');
    const entry = corpus.cases.find((c) => c.path === 'part.stl');
    assert.equal(entry.rustAccepts, false);
    assert.equal(entry.rustReferenceAccepts, true);
    const corpusPath = join(directory, 'corpus.json');
    const reportPath = join(directory, 'report.json');
    writeFileSync(corpusPath, produced.stdout);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./source-path-replay.mjs', import.meta.url)),
      fileURLToPath(new URL('../../../web/apps/server/dist/current/services/local-source-snapshot.js', import.meta.url)),
      corpusPath, reportPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.unexpectedMismatches, 1);
    assert.equal(report.unexpectedCases[0].path, 'part.stl');
    assert.equal(report.unexpectedCases[0].nodeAccepts, true);
    assert.equal(report.unexpectedCases[0].rustReferenceAccepts, true);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('the CLI writes evidence and exits 1 for the masked NFC regression', () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-path-replay-'));
  try {
    const modulePath = join(directory, 'mutant.mjs');
    const corpusPath = join(directory, 'corpus.json');
    const reportPath = join(directory, 'report.json');
    writeFileSync(modulePath, `export const SOURCE_SNAPSHOT_MANIFEST_FILE = ${JSON.stringify(manifest)};
export const sourceRelativePath = (p) => p.normalize('NFC');\n`);
    writeFileSync(corpusPath, JSON.stringify(corpusOf({
      path: 'a\u0301:.stl', rustNfc: '\u00e1:.stl', rustAccepts: false,
    })));
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./source-path-replay.mjs', import.meta.url)), modulePath, corpusPath, reportPath,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.unexpectedMismatches, 1);
    assert.equal(report.mismatchCases[0].classification, 'unexpected');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('empty or incomplete corpus data cannot report a false zero', () => {
  assert.throws(() => run(corpusOf()), /empty/);
  assert.throws(() => run(corpusOf({ path: 'part.stl', rustAccepts: true })), /Invalid SourcePath case/);
});
