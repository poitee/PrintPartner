import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./check-ci-tool-pins.mjs', import.meta.url));
const action = 'taiki-e/install-action@ab6895351a88b908e96a4697860d4ffea5e57dbe';
const workflow = step => `jobs:\n  probe:\n    steps:\n${step}\n`;
const installer = input => workflow(`      - uses: ${action}\n        with:\n          tool: ${input}`);
const summary = (declarations, tools, errors) => `install_declarations=${declarations} tool_specs=${tools} errors=${errors}\n`;

function run(t, source, args = [], filename = 'fixture.yaml') {
  const directory = mkdtempSync(join(tmpdir(), 'ci-tool-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, filename);
  if (source !== undefined) writeFileSync(file, source);
  const result = spawnSync(process.execPath, [cli, directory, ...args], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return { ...result, file, directory };
}

const setupNode = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1';
const matrixInput = '${{ matrix.node }}';
const desktop = (matrix = { node: ['22.23.3', '24.21.0'] }, steps = [
  { uses: setupNode, with: { 'node-version': matrixInput } },
]) => JSON.stringify({ jobs: { parity: { strategy: { matrix }, steps } } });

for (const [name, source] of [
  ['exact patches', desktop()],
  ['future patch bump', desktop({ node: ['22.23.4', '24.21.1'] })],
  ['compact expression', desktop(undefined, [{ uses: setupNode, with: { 'node-version': '${{matrix.node}}' } }])],
  ['anchored matrix', `nodes: &nodes ['22.23.3', '24.21.0']\njobs:\n  parity:\n    strategy:\n      matrix: {node: *nodes}\n    steps:\n      - uses: ${setupNode}\n        with: {node-version: '${matrixInput}'}`],
]) {
  test(`accept desktop Node ${name}`, t => {
    const result = run(t, source, [], 'desktop-contracts.yml');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, summary(0, 0, 0));
  });
}

for (const value of ['22', '24', '22.23', '22.x', 'lts/*', 'latest', 'node', '^22.23.3', '>=22', 'v22.23.3', '22.23.3-rc.1', '22.23.3+build', '022.23.3', '', '${{ inputs.node }}', 22, 22.23, null, {}]) {
  test(`reject desktop Node version ${JSON.stringify(value)}`, t => {
    const result = run(t, desktop({ node: [value, '24.21.0'] }), [], 'desktop-contracts.yml');
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr, `${result.file} jobs.parity.strategy.matrix.node[0]: UNPINNED_NODE: ${JSON.stringify(value)}; expected major.minor.patch string\n`);
    assert.equal(result.stdout, summary(0, 0, 1));
  });
}

for (const [name, source, diagnostic] of [
  ['empty matrix', desktop({ node: [] }), 'INVALID_NODE_MATRIX'],
  ['scalar node', desktop({ node: '22.23.3' }), 'INVALID_NODE_MATRIX'],
  ['missing node', desktop({}), 'INVALID_NODE_MATRIX'],
  ['dynamic matrix', desktop('${{ fromJSON(inputs.matrix) }}'), 'INVALID_NODE_MATRIX'],
  ['duplicate version', desktop({ node: ['22.23.3', '22.23.3'] }), 'INVALID_NODE_MATRIX'],
  ['include override', desktop({ node: ['22.23.3'], include: [{ node: '24' }] }), 'INVALID_NODE_MATRIX'],
  ['exclude override', desktop({ node: ['22.23.3'], exclude: [] }), 'INVALID_NODE_MATRIX'],
  ['extra axis', desktop({ node: ['22.23.3'], os: ['ubuntu-latest'] }), 'INVALID_NODE_MATRIX'],
  ['missing parity', 'jobs: {other: {steps: []}}', 'INVALID_NODE_MATRIX'],
  ['missing strategy', `jobs: {parity: {steps: [{uses: '${setupNode}'}]}}`, 'INVALID_NODE_MATRIX'],
  ['missing setup', desktop(undefined, []), 'INVALID_NODE_SETUP'],
  ['duplicate setup', desktop(undefined, [{ uses: setupNode }, { uses: setupNode }]), 'INVALID_NODE_SETUP'],
  ...['24', '${{ matrix.other }}', '${{ inputs.node }}', null].map(value => [
    `bypassed matrix ${value}`, desktop(undefined, [{ uses: setupNode, with: { 'node-version': value } }]), 'INVALID_NODE_SETUP',
  ]),
  ['version file', desktop(undefined, [{ uses: setupNode, with: { 'node-version': matrixInput, 'node-version-file': '.nvmrc' } }]), 'INVALID_NODE_SETUP'],
  ['missing inputs', desktop(undefined, [{ uses: setupNode }]), 'INVALID_NODE_SETUP'],
  ['anchored floating matrix', `nodes: &nodes ['22', '24.21.0']\njobs: {parity: {strategy: {matrix: {node: *nodes}}, steps: [{uses: '${setupNode}', with: {node-version: '${matrixInput}'}}]}}`, 'UNPINNED_NODE'],
]) {
  test(`reject desktop Node ${name}`, t => {
    const result = run(t, source, [], 'desktop-contracts.yml');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`: ${diagnostic}:`));
  });
}

test('Node policy leaves unrelated workflows unchanged', t => {
  const result = run(t, desktop({ node: ['22', '24'] }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, summary(0, 0, 0));
});

for (const filename of ['desktop-contracts.yaml', 'desktop-contracts.YML', 'DESKTOP-CONTRACTS.YAML']) {
  test(`reject floating Node pins after rename to ${filename}`, t => {
    const result = run(t, desktop({ node: ['22', '24'] }), [], filename);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, summary(0, 0, 2));
    assert.match(result.stderr, /UNPINNED_NODE: "22"/);
    assert.match(result.stderr, /UNPINNED_NODE: "24"/);
  });

  test(`accept exact Node pins after rename to ${filename}`, t => {
    const result = run(t, desktop(), [], filename);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, summary(0, 0, 0));
    assert.equal(result.stderr, '');
  });
}

for (const [name, source, declarations, tools] of [
  ['current releases', installer('nextest@0.9.148, sccache@0.18.0 ast-grep@0.50.0 cargo-machete@0.9.2'), 1, 4],
  ['quoted flow keys and reordered inputs', `"jobs": {probe: {"steps": [{with: {"tool": "nextest@0.9.148"}, "uses": '${action}'}]}}`, 1, 1],
  ['folded whitespace list', installer('>\n            nextest@0.9.148\n            sccache@0.18.0'), 1, 2],
  ['CRLF and no trailing newline', installer("'nextest@0.9.148' # exact release").trimEnd().replaceAll('\n', '\r\n'), 1, 1],
  ['complete steps anchor', `jobs:\n  first:\n    steps: &steps\n      - uses: ${action}\n        with: &inputs\n          tool: &tool nextest@0.9.148\n  second:\n    steps: *steps\n  third:\n    steps:\n      - uses: ${action}\n        with: *inputs\n      - uses: ${action}\n        with: {tool: *tool}\n`, 3, 3],
  ['unrelated tool inputs and shell text', workflow(`      - uses: other/action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n        with: {tool: nextest}\n      - run: |\n          echo 'uses: ${action}'\n          echo 'tool: nextest'`), 0, 0],
  ['reusable workflow job', 'jobs: {probe: {uses: owner/repo/.github/workflows/reuse.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}', 0, 0],
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
  ['adjacent unrelated tool', workflow(`      - uses: ${action}\n      - uses: other/action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n        with: {tool: nextest@0.9.148}`), 'INVALID_TOOL'],
  ['sub-action', workflow(`      - uses: taiki-e/install-action/nextest@v2`), 'INVALID_INSTALLER', 'jobs.probe.steps[0].uses'],
  ['missing installer ref', workflow('      - uses: taiki-e/install-action'), 'INVALID_INSTALLER', 'jobs.probe.steps[0].uses'],
  ['duplicate tool key', installer('nextest@0.9.148\n          tool: nextest'), 'INVALID_YAML', '$'],
  ['duplicate uses key', workflow(`      - uses: ${action}\n        uses: other/action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`), 'INVALID_YAML', '$'],
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
  assert.equal(result.stderr, 'Usage: node web/scripts/check-ci-tool-pins.mjs [workflow-directory]\n');
});

test('missing parser gives setup instruction', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-tool-parser-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'web/scripts'), { recursive: true });
  const isolated = join(directory, 'web/scripts/check-ci-tool-pins.mjs');
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

const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';

for (const [name, source] of [
  ['quoted uses key', workflow(`      - "uses": actions/checkout@v7`)],
  ['flow step', 'jobs: {probe: {steps: [{uses: actions/checkout@v7}]}}'],
  ['anchored step', 'step: &checkout {uses: actions/checkout@v7}\njobs: {probe: {steps: [*checkout]}}'],
  ['anchored scalar', 'ref: &ref actions/checkout@v7\njobs: {probe: {steps: [{uses: *ref}]}}'],
  ['anchored steps', 'jobs: {probe: {steps: &steps [{uses: actions/checkout@v7}]}, second: {steps: *steps}}'],
  ['reusable workflow', 'jobs: {probe: {uses: owner/repo/.github/workflows/ci.yml@main}}'],
  ['sub-action tag', workflow('      - uses: owner/repo/path@v1')],
  ['short SHA', workflow('      - uses: actions/checkout@3d3c42e')],
  ['missing ref', workflow('      - uses: actions/checkout')],
  ['extra ref separator', workflow(`      - uses: owner/repo@tag@${'a'.repeat(40)}`)],
  ['ref suffix', workflow(`      - uses: ${checkout}suffix`)],
  ['image tag', workflow('      - uses: docker://alpine:3.22')],
  ['Docker Git-style SHA', workflow(`      - uses: docker://alpine@${'a'.repeat(40)}`)],
  ['short Docker digest', workflow(`      - uses: docker://alpine@sha256:${'a'.repeat(63)}`)],
  ['nonhex Docker digest', workflow(`      - uses: docker://alpine@sha256:${'g'.repeat(64)}`)],
  ['long Docker digest', workflow(`      - uses: docker://alpine@sha256:${'a'.repeat(65)}`)],
  ['missing Docker image', workflow(`      - uses: docker://@sha256:${'a'.repeat(64)}`)],
  ['bare SHA', workflow(`      - uses: ${'a'.repeat(40)}`)],
]) {
  test(`reject unpinned action in ${name}`, t => {
    const result = run(t, source);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /UNPINNED_ACTION:/);
    assert.match(result.stdout, / errors=[1-9]\d*\n$/);
  });
}

for (const [name, source] of [
  ['quoted uses key', workflow(`      - "uses": '${checkout}'`)],
  ['flow step', `jobs: {probe: {steps: [{uses: '${checkout}'}]}}`],
  ['anchored step', `step: &checkout {uses: '${checkout}'}\njobs: {probe: {steps: [*checkout]}}`],
  ['reusable workflow', `jobs: {probe: {uses: owner/repo/.github/workflows/ci.yml@${'a'.repeat(40)}}}`],
  ['sub-action SHA', workflow(`      - uses: owner/repo/path@${'A'.repeat(40)}`)],
  ['Docker digest', workflow(`      - uses: docker://alpine@sha256:${'a'.repeat(64)}`)],
  ['tagged image with digest', workflow(`      - uses: docker://ghcr.io/owner/image:tag@sha256:${'a'.repeat(64)}`)],
  ['local action', workflow('      - uses: ./local/action')],
  ['local reusable workflow', 'jobs: {probe: {uses: ./.github/workflows/ci.yml}}'],
  ['shell example', workflow(`      - run: |\n          echo 'uses: actions/checkout@v7'`)],
]) {
  test(`accept immutable or local action in ${name}`, t => {
    const result = run(t, source);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, summary(0, 0, 0));
  });
}
