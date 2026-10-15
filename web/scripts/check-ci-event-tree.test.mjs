import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import YAML from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = 'web/scripts/check-ci-tool-pins.mjs';
const contracts = '.github/workflows/desktop-contracts.yml';
const original = readFileSync(join(root, contracts), 'utf8');
const webCI = YAML.parse(readFileSync(join(root, '.github/workflows/web-ci.yml'), 'utf8'));

function fixture(t, mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-event-tree-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, '.github/workflows'), { recursive: true });
  mkdirSync(join(directory, 'web/scripts'), { recursive: true });
  copyFileSync(join(root, cli), join(directory, cli));
  symlinkSync(join(root, 'web/node_modules'), join(directory, 'web/node_modules'));
  writeFileSync(join(directory, contracts), original);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  mutate(directory);
  git('add', '.github', cli);
  const commit = () => {
    git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const sha = commit();
  const run = (eventSha = sha) => spawnSync(process.execPath, [join(directory, cli), '--event-sha', eventSha], {
    cwd: directory, encoding: 'utf8',
  });
  return { directory, git, commit, sha, run };
}

for (const [name, mutate] of [
  ['missing', directory => rmSync(join(directory, contracts))],
  ['renamed', directory => renameSync(join(directory, contracts), join(directory, '.github/workflows/renamed.yml'))],
  ['disabled suffix', directory => renameSync(join(directory, contracts), join(directory, `${contracts}.disabled`))],
  ['uppercase extension', directory => renameSync(join(directory, contracts), join(directory, '.github/workflows/desktop-contracts.YML'))],
  ['symlink', directory => {
    rmSync(join(directory, contracts));
    symlinkSync('other.yml', join(directory, contracts));
    writeFileSync(join(directory, '.github/workflows/other.yml'), original);
  }],
  ['duplicate', directory => writeFileSync(join(directory, '.github/workflows/desktop-contracts.yaml'), original)],
]) {
  test(`event tree rejects ${name} despite restored worktree and HEAD`, t => {
    const f = fixture(t, mutate);
    rmSync(join(f.directory, contracts), { force: true });
    writeFileSync(join(f.directory, contracts), original);
    if (name === 'duplicate') rmSync(join(f.directory, '.github/workflows/desktop-contracts.yaml'));
    f.git('add', '.github');
    f.commit();
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /INVALID_EVENT_DESKTOP_CONTRACTS/);
  });
}

const modify = change => directory => {
  const workflow = YAML.parse(original);
  change(workflow);
  writeFileSync(join(directory, contracts), YAML.stringify(workflow));
};

test('event tree rejects unpinned actions in tabbed workflow filename', t => {
  const f = fixture(t, directory => {
    writeFileSync(join(directory, '.github/workflows/probe\t.yml'),
      'jobs: {probe: {steps: [{uses: actions/checkout@main}]}}');
  });
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /UNPINNED_ACTION/);
});

test('event tree does not mistake tabbed filename for required contracts workflow', t => {
  const f = fixture(t, directory => {
    renameSync(join(directory, contracts), join(directory, `${contracts}\tother.yml`));
  });
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /INVALID_EVENT_DESKTOP_CONTRACTS/);
});

test('event tree accepts pinned actions in tabbed workflow filename', t => {
  const f = fixture(t, directory => {
    writeFileSync(join(directory, '.github/workflows/probe\t.yml'),
      `jobs: {probe: {steps: [{uses: actions/checkout@${'a'.repeat(40)}}]}}`);
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, change] of [
  ['manual only', w => { w.on = { workflow_dispatch: null }; }],
  ['trigger list', w => { w.on = ['push', 'pull_request']; }],
  ['missing PR trigger', w => { delete w.on.pull_request; }],
  ['closed PRs only', w => { w.on.pull_request.types = ['closed']; }],
  ['ignored paths', w => { w.on.push['paths-ignore'] = ['**']; }],
  ['removed coverage', w => { w.on.push.paths.shift(); }],
  ['negative path', w => { w.on.pull_request.paths.push('!rust/**'); }],
  ['wrong branch', w => { w.on.push.branches = ['never']; }],
  ['negative branch', w => { w.on.push.branches.push('!main'); }],
  ['job false', w => { w.jobs.parity.if = false; }],
  ['job expression', w => { w.jobs.parity.if = '${{ false }}'; }],
  ['job dependency', w => { w.jobs.parity.needs = ['skipped']; }],
  ['job failure ignored', w => { w.jobs.parity['continue-on-error'] = true; }],
  ['step false', w => { w.jobs.parity.steps[0].if = false; }],
  ['step failure ignored', w => { w.jobs.parity.steps[0]['continue-on-error'] = true; }],
  ['verification removed', w => { w.jobs.parity.steps = w.jobs.parity.steps.filter(s => !s.run?.includes('npm run contracts:verify')); }],
]) {
  test(`event tree rejects disabled workflow ${name}`, t => {
    const f = fixture(t, modify(change));
    writeFileSync(join(f.directory, contracts), original);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /INVALID_DESKTOP_TRIGGERS|DISABLED_DESKTOP_|MISSING_DESKTOP_VERIFICATION/);
  });
}

test('event tree accepts original blob despite deleted worktree and moved HEAD', t => {
  const f = fixture(t);
  rmSync(join(f.directory, contracts));
  f.git('add', '.github');
  f.commit();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'install_declarations=0 tool_specs=0 errors=0\n');
});

test('event tree ignores replacement commit', t => {
  const f = fixture(t, directory => rmSync(join(directory, contracts)));
  writeFileSync(join(f.directory, contracts), original);
  f.git('add', '.github');
  const replacement = f.commit();
  f.git('replace', f.sha, replacement);
  assert.equal(f.run().status, 1);
});

test('event tree ignores replacement workflow blob', t => {
  const f = fixture(t, modify(w => { w.jobs.parity.if = false; }));
  const disabled = f.git('rev-parse', `${f.sha}:${contracts}`);
  writeFileSync(join(f.directory, contracts), original);
  f.git('add', '.github');
  const replacement = f.git('rev-parse', `:${contracts}`);
  f.git('replace', disabled, replacement);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /DISABLED_DESKTOP_JOB/);
});

test('event tree rejects gitlink at required workflow path', t => {
  const f = fixture(t);
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.sha},${contracts}`);
  const sha = f.commit();
  const result = f.run(sha);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /INVALID_EVENT_DESKTOP_CONTRACTS/);
});

test('event tree rejects yaml extension despite corrected trigger coverage', t => {
  const f = fixture(t, modify(w => {
    for (const trigger of [w.on.push, w.on.pull_request]) {
      trigger.paths.push('docs/**');
      trigger.paths = trigger.paths.map(p => p.replace('desktop-contracts.yml', 'desktop-contracts.yaml'));
    }
  }));
  f.git('mv', contracts, '.github/workflows/desktop-contracts.yaml');
  const sha = f.commit();
  const result = f.run(sha);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /INVALID_EVENT_DESKTOP_CONTRACTS/);
});

test('event tree accepts extra trigger coverage', t => {
  const f = fixture(t, modify(w => {
    w.on.push.paths.push('docs/**');
    w.on.pull_request.paths.push('docs/**');
  }));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

for (const sha of ['', 'HEAD', 'a'.repeat(40), '--help', 'a'.repeat(39)]) {
  test(`event tree rejects invalid or unavailable SHA ${JSON.stringify(sha)}`, t => {
    const f = fixture(t);
    const result = f.run(sha);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /INVALID_EVENT_TREE/);
  });
}

for (const job of ['web', 'web-build']) {
  for (const valid of [false, true]) {
    test(`${job} lifecycle sentinel ${valid ? 'runs after valid event' : 'never runs for missing event workflow'}`, t => {
      const f = fixture(t, directory => {
        if (!valid) rmSync(join(directory, contracts));
      });
      const web = join(f.directory, 'web');
      rmSync(join(web, 'node_modules'));
      writeFileSync(join(web, 'package.json'), JSON.stringify({
        name: 'lifecycle-proof', version: '1.0.0', private: true,
        dependencies: { yaml: '2.9.1' },
        scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\', \'yes\')"' },
      }));
      const lock = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: web, encoding: 'utf8' });
      assert.equal(lock.status, 0, lock.stderr);
      const steps = webCI.jobs[job].steps;
      const start = steps.findIndex(step => step.run?.startsWith('npm ci'));
      const commands = [];
      for (const step of steps.slice(start)) {
        if (!step.run) continue;
        commands.push(`cd "${step['working-directory'] === '.' ? f.directory : web}"\n${step.run}`);
        if (step.run === 'npm rebuild' || step.name === 'Check Action SHAs and CI installer tool pins') break;
      }
      const result = spawnSync('bash', ['-e', '-c', commands.join('\n')], {
        cwd: web, encoding: 'utf8', env: { ...process.env, EVENT_SHA: f.sha, GITHUB_SHA: f.sha },
      });
      assert.equal(existsSync(join(web, 'lifecycle-ran')), valid, result.stdout + result.stderr);
      assert.equal(result.status, valid ? 0 : 1, result.stdout + result.stderr);
      if (!valid) assert.match(result.stderr, /INVALID_EVENT_DESKTOP_CONTRACTS/);
    });
  }
}
