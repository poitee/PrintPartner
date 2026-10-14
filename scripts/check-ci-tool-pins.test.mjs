import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./check-ci-tool-pins.mjs', import.meta.url));
const action = 'taiki-e/install-action@ab6895351a88b908e96a4697860d4ffea5e57dbe';
const workflow = step => `jobs:\n  probe:\n    steps:\n${step}\n`;
const installer = input => workflow(`      - uses: ${action}\n        with:\n          tool: ${input}`);
const summary = (declarations, tools, errors) => `install_declarations=${declarations} tool_specs=${tools} errors=${errors}\n`;

function run(t, source, args = []) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-tool-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture.yaml');
  if (source !== undefined) writeFileSync(file, source);
  const result = spawnSync(process.execPath, [cli, directory, ...args], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return { ...result, file, directory };
}

for (const [name, source, declarations, tools] of [
  ['current releases', installer('nextest@0.9.148, sccache@0.18.0 ast-grep@0.50.0 cargo-machete@0.9.2'), 1, 4],
  ['quoted flow keys and reordered inputs', `"jobs": {probe: {"steps": [{with: {"tool": "nextest@0.9.148"}, "uses": '${action}'}]}}`, 1, 1],
  ['folded whitespace list', installer('>\n            nextest@0.9.148\n            sccache@0.18.0'), 1, 2],
  ['CRLF and no trailing newline', installer("'nextest@0.9.148' # exact release").trimEnd().replaceAll('\n', '\r\n'), 1, 1],
  ['complete steps anchor', `jobs:\n  first:\n    steps: &steps\n      - uses: ${action}\n        with: &inputs\n          tool: &tool nextest@0.9.148\n  second:\n    steps: *steps\n  third:\n    steps:\n      - uses: ${action}\n        with: *inputs\n      - uses: ${action}\n        with: {tool: *tool}\n`, 3, 3],
  ['unrelated tool inputs and shell text', workflow(`      - uses: other/action@v1\n        with: {tool: nextest}\n      - run: |\n          echo 'uses: ${action}'\n          echo 'tool: nextest'`), 0, 0],
  ['reusable workflow job', 'jobs: {probe: {uses: owner/repo/.github/workflows/reuse.yml@main}}', 0, 0],
]) {
  test(name, t => {
    const result = run(t, source);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, summary(declarations, tools, 0));
  });
}

for (const token of ['nextest', 'sccache', 'nextest@latest', 'nextest@main', 'nextest@0.9', 'nextest@^0.9.148', 'nextest@>=0.9.148', 'nextest@0.9.148-beta', 'nextest@0.9.148+build', 'nextest@00.9.148']) {
  test(`reject floating release ${token}`, t => {
    const result = run(t, installer(JSON.stringify(token)));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, summary(1, 0, 1));
    assert.equal(result.stderr, `${result.file} jobs.probe.steps[0].with.tool: UNPINNED_TOOL: ${JSON.stringify(token)}; expected name@major.minor.patch\n`);
  });
}

for (const [name, source, diagnostic, path = 'jobs.probe.steps[0].with.tool'] of [
  ['dynamic tool', installer("'nextest@${{ matrix.version }}'"), 'INVALID_TOOL'],
  ['dynamic action', workflow("      - uses: '${{ matrix.action }}'"), 'INVALID_USES', 'jobs.probe.steps[0].uses'],
  ['missing with', workflow(`      - uses: ${action}`), 'INVALID_TOOL'],
  ['missing tool', workflow(`      - uses: ${action}\n        with: {args: test}`), 'INVALID_TOOL'],
  ['empty tool', installer("''"), 'INVALID_TOOL'],
  ['null tool', installer('null'), 'INVALID_TOOL'],
  ['numeric tool', installer('123'), 'INVALID_TOOL'],
  ['sequence tool', installer('[nextest@0.9.148]'), 'INVALID_TOOL'],
  ['mapping tool', installer('{nextest: 0.9.148}'), 'INVALID_TOOL'],
  ['mixed comma list', installer('nextest@0.9.148, sccache'), 'UNPINNED_TOOL'],
  ['mixed whitespace list', installer('nextest@0.9.148 sccache'), 'UNPINNED_TOOL'],
  ['empty comma entry', installer('nextest@0.9.148,'), 'UNPINNED_TOOL'],
  ['duplicate tool names', installer('nextest@0.9.148 nextest@0.9.147'), 'DUPLICATE_TOOL'],
  ['flow floating input', `jobs: {probe: {steps: [{uses: '${action}', with: {'tool': nextest}}]}}`, 'UNPINNED_TOOL'],
  ['anchored floating inputs', `inputs: &inputs {tool: nextest}\njobs: {probe: {steps: [{uses: '${action}', with: *inputs}]}}`, 'UNPINNED_TOOL'],
  ['anchored floating steps', `jobs: {probe: {steps: &steps [{uses: '${action}', with: {tool: nextest}}]}, second: {steps: *steps}}`, 'UNPINNED_TOOL'],
  ['anchored floating scalar', `tool: &tool sccache\njobs: {probe: {steps: [{uses: '${action}', with: {tool: *tool}}]}}`, 'UNPINNED_TOOL'],
  ['adjacent unrelated tool', workflow(`      - uses: ${action}\n      - uses: other/action@v1\n        with: {tool: nextest@0.9.148}`), 'INVALID_TOOL'],
  ['sub-action', workflow(`      - uses: taiki-e/install-action/nextest@v2`), 'INVALID_INSTALLER', 'jobs.probe.steps[0].uses'],
  ['missing installer ref', workflow('      - uses: taiki-e/install-action'), 'INVALID_INSTALLER', 'jobs.probe.steps[0].uses'],
  ['duplicate tool key', installer('nextest@0.9.148\n          tool: nextest'), 'INVALID_YAML', '$'],
  ['duplicate uses key', workflow(`      - uses: ${action}\n        uses: other/action@v1`), 'INVALID_YAML', '$'],
  ['duplicate with key', workflow(`      - uses: ${action}\n        with: {tool: nextest}\n        with: {tool: nextest@0.9.148}`), 'INVALID_YAML', '$'],
  ['duplicate steps key', 'jobs: {probe: {steps: [], steps: []}}', 'INVALID_YAML', '$'],
  ['duplicate jobs key', 'jobs: {}\njobs: {}', 'INVALID_YAML', '$'],
  ['malformed YAML', 'jobs: [', 'INVALID_YAML', '$'],
  ['multiple documents', 'jobs: {}\n---\njobs: {}', 'INVALID_YAML', '$'],
  ['merge key', `inputs: &inputs {tool: nextest}\njobs: {probe: {steps: [{uses: '${action}', with: {<<: *inputs}}]}}`, 'UNSUPPORTED_YAML', '$'],
  ['custom tag', installer('!unknown nextest'), 'INVALID_YAML', '$'],
  ['non-string mapping key', 'jobs: {123: {steps: []}}', 'UNSUPPORTED_YAML', '$'],
  ['unresolved alias', 'jobs: *missing', 'READ_OR_PARSE_ERROR', '$'],
  ['alias expansion limit', `step: &step {uses: '${action}', with: {tool: nextest@0.9.148}}\njobs: {probe: {steps: [${Array(101).fill('*step').join(', ')}]}}`, 'READ_OR_PARSE_ERROR', '$'],
  ['null jobs', 'jobs: null', 'INVALID_SHAPE', 'jobs'],
  ['sequence jobs', 'jobs: []', 'INVALID_SHAPE', 'jobs'],
  ['invalid job', 'jobs: {probe: null}', 'INVALID_SHAPE', 'jobs.probe'],
  ['dynamic steps', "jobs: {probe: {steps: '${{ matrix.steps }}'}}", 'INVALID_SHAPE', 'jobs.probe.steps'],
  ['mapping steps', `jobs: {probe: {steps: {uses: '${action}', with: {tool: nextest}}}}`, 'INVALID_SHAPE', 'jobs.probe.steps'],
  ['set-tagged step', `jobs: {probe: {steps: [!!set {uses: null, with: null}]}}`, 'INVALID_SHAPE', 'jobs.probe.steps[0]'],
  ['scalar step', 'jobs: {probe: {steps: [nextest]}}', 'INVALID_SHAPE', 'jobs.probe.steps[0]'],
  ['job uses and steps', 'jobs: {probe: {uses: owner/reuse@main, steps: []}}', 'INVALID_SHAPE', 'jobs.probe'],
]) {
  test(`reject ${name}`, t => {
    const result = run(t, source);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(`${result.file} ${path}: ${diagnostic}:`), result.stderr);
    assert.match(result.stdout, / errors=[1-9]\d*\n$/);
  });
}

test('empty directory', t => {
  const result = run(t);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, summary(0, 0, 1));
  assert.equal(result.stderr, `${result.directory} $: NO_WORKFLOWS: no .yml or .yaml workflow files found\n`);
});

test('missing directory', t => {
  const result = run(t);
  rmSync(result.directory, { recursive: true });
  const missing = spawnSync(process.execPath, [cli, result.directory], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /READ_ERROR: ENOENT/);
  assert.equal(missing.stdout, summary(0, 0, 1));
});

test('extra arguments fail usage', t => {
  const result = run(t, installer('nextest'), ['extra']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Usage: node scripts/check-ci-tool-pins.mjs [workflow-directory]\n');
});

test('missing parser gives setup instruction', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-tool-parser-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts'));
  const isolated = join(directory, 'scripts/check-ci-tool-pins.mjs');
  copyFileSync(cli, isolated);
  const result = spawnSync(process.execPath, [isolated], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'MISSING_PARSER: run npm ci in web/ before checking CI tool pins\n');
});

test('mixed list reports only the floating token', t => {
  const result = run(t, installer('nextest@0.9.148, sccache'));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, summary(1, 1, 1));
  assert.equal(result.stderr, `${result.file} jobs.probe.steps[0].with.tool: UNPINNED_TOOL: "sccache"; expected name@major.minor.patch\n`);
});
