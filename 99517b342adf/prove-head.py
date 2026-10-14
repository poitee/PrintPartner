import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path('/persist/worktrees/t3/PrintPartner/owner-gre353-next-202610141227-9efa')
state = Path('/persist/home/.local/state/pstack-t3/gre353-owner-mapping')
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip()
stage = state / ('exact-' + head[:12] + '-stage')
proof_dir = state / ('exact-' + head[:12])
proof_dir.mkdir(exist_ok=True)
env = dict(os.environ, VITE_PRINT_PARTNER_DESKTOP='1', CARGO_BUILD_JOBS='4',
           CARGO_TARGET_DIR='/persist/home/.local/state/pstack-t3/gre353-next/target',
           PP_DESKTOP_RELEASE_MANIFEST=str(stage / 'bundle-manifest.json'))
env.pop('PP_DESKTOP_REBUILD', None)
commands = [
    ('web-build.log', ['npm', '--prefix', 'web', 'run', 'build']),
    ('stage.log', ['python3', 'rust/scripts/stage-desktop.py', '--web', 'web', '--node',
                   '/opt/agent-fleet/artifacts/.local/share/mise/installs/node/24.21.0/bin/node',
                   '--output', str(stage), '--commit', head]),
    ('node-tests.log', ['npm', '--prefix', 'web', 'run', 'test', '-w', '@print-partner/server', '--',
                         'src/desktop-account.test.ts', 'src/desktop-context.test.ts']),
    ('typecheck.log', ['npm', '--prefix', 'web', 'run', 'typecheck', '-w', '@print-partner/server']),
    ('fmt.log', ['cargo', 'fmt', '--manifest-path', 'rust/Cargo.toml', '--all', '--check']),
    ('pin-unit.log', ['cargo', 'nextest', 'run', '--locked', '--manifest-path', 'rust/Cargo.toml',
                      '-p', 'pp-compat', '--features', 'desktop_rebuild', '--lib', '--no-tests=fail',
                      '-E', 'test(account_pin)']),
    ('mixed-feature.log', ['cargo', 'check', '--locked', '--manifest-path', 'rust/Cargo.toml',
                           '-p', 'pp-core', '--features', 'pp-compat/desktop_rebuild']),
    ('pin-unit-off.log', ['cargo', 'nextest', 'run', '--locked', '--manifest-path', 'rust/Cargo.toml',
                          '-p', 'pp-compat', '--lib', '--no-tests=fail', '-E', 'test(account_pin)']),
    ('mapping-mixed.log', ['cargo', 'nextest', 'run', '--locked', '--manifest-path', 'rust/Cargo.toml',
                           '-p', 'pp-core', '--features', 'pp-compat/desktop_rebuild', '--test', 'runtime_m0',
                           '--success-output=immediate', '--no-tests=fail',
                           '-E', 'test(ticket_t_68_desktop_account_mapping)']),
    ('artifacts-on.jsonl', ['cargo', 'test', '--locked', '--manifest-path', 'rust/Cargo.toml',
                           '-p', 'pp-core', '--features', 'desktop_rebuild', '--test', 'runtime_m0',
                           '--no-run', '--message-format=json']),
    ('mapping-on.log', ['cargo', 'nextest', 'run', '--locked', '--manifest-path', 'rust/Cargo.toml',
                        '-p', 'pp-core', '--features', 'desktop_rebuild', '--test', 'runtime_m0',
                        '--success-output=immediate', '--no-tests=fail', '-E', 'test(ticket_t_68_desktop_account_mapping)']),
    ('artifacts-off.jsonl', ['cargo', 'test', '--locked', '--manifest-path', 'rust/Cargo.toml',
                            '-p', 'pp-core', '--test', 'runtime_m0', '--no-run', '--message-format=json']),
    ('mapping-off.log', ['cargo', 'nextest', 'run', '--locked', '--manifest-path', 'rust/Cargo.toml',
                         '-p', 'pp-core', '--test', 'runtime_m0', '--success-output=immediate', '--no-tests=fail',
                         '-E', 'test(ticket_t_68_desktop_account_mapping)']),
    ('lifecycle-off.log', ['cargo', 'nextest', 'run', '--locked', '--manifest-path', 'rust/Cargo.toml',
                           '-p', 'pp-core', '--test', 'runtime_m0', '--success-output=immediate', '--no-tests=fail',
                           '-E', 'test(protected_real_node_lifecycle)']),
]
slot = ['python3', '/persist/home/pstack-t3/skills/landing/scripts/land.py', 'slot', '--']
for name, command in commands:
    print('Running ' + name, flush=True)
    with (proof_dir / name).open('w') as log:
        subprocess.run(slot + command, cwd=root, env=env, stdout=log,
                       stderr=subprocess.STDOUT, check=True)
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip() == head
assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip()
files = subprocess.check_output(['git', 'diff', '--name-only', 'origin/main...HEAD'], cwd=root,
                                text=True).splitlines()
hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}
hashes['stage/bundle-manifest.json'] = hashlib.sha256((stage / 'bundle-manifest.json').read_bytes()).hexdigest()
artifacts = {}
for config in ['on', 'off']:
    for line in (proof_dir / ('artifacts-' + config + '.jsonl')).read_text().splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if value.get('reason') == 'compiler-artifact' and value.get('target', {}).get('name') == 'runtime_m0' and value.get('executable'):
            binary = Path(value['executable'])
            artifacts[config] = {'binary': str(binary), 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
assert set(artifacts) == {'on', 'off'}
proof = {'head': head, 'result': 'PASS', 'proof_class': 'unsigned_linux_real_gateway_node_account_mapping',
         'stage': str(stage), 'commands': commands, 'source_and_manifest_sha256': hashes, 'runtime_test_artifacts': artifacts,
         'native_ui_claim': False, 'macos_or_signed_release_claim': False}
(proof_dir / 'head-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
(state / 'proof-dir.txt').write_text(str(proof_dir) + '\n')
print('Exact-head author proof PASS at ' + head, flush=True)
