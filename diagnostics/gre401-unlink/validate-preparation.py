#!/usr/bin/env python3
"""Validate preparation only. Never emulate native events."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import yaml


folder = Path(__file__).resolve().parent
repo = folder.parents[1]
workflow = repo / '.github/workflows/desktop-native-macos.yml'
probe = folder / 'native-vnode-probe.py'
results = []
for path in folder.glob('*.py'):
    ast.parse(path.read_text(), filename=str(path))
    results.append({'python_ast': path.name, 'status': 'valid'})

binary = Path('/tmp/gre384-evidence/actionlint/actionlint')
pinned_hash = 'c872d6db8c6bf83a8eaa704fc93999f027d55dffbc63b8a6abdccb47df5f4cd4'
assert hashlib.sha256(binary.read_bytes()).hexdigest() == pinned_hash
for command in ([str(binary), '-version'], [str(binary), str(workflow)]):
    completed = subprocess.run(command, capture_output=True, text=True)
    results.append({'argv': command, 'exit_code': completed.returncode,
                    'stdout': completed.stdout, 'stderr': completed.stderr})
    assert completed.returncode == 0

# This inventory supports source inspection. It cannot prove arbitrary Python safe.
module = ast.parse(probe.read_text())
mutations = []
for node in ast.walk(module):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if node.func.attr in {'mkdir', 'rename', 'rmdir', 'chmod', 'write', 'unlink', 'open'}:
            mutations.append({'line': node.lineno, 'expression': ast.unparse(node)})
results.append({'mutation_inventory': sorted(mutations, key=lambda item: item['line']),
                'status': 'requires_human_source_inspection'})
assert 'os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC' in probe.read_text()
assert not any(token in probe.read_text() for token in ('shutil.', 'os.system(', 'shell=True', 'sudo'))
policy = yaml.load(workflow.read_text(), Loader=yaml.BaseLoader)
assert set(policy['on']) == {'workflow_dispatch'}
assert policy['permissions'] == {'contents': 'read'}
assert policy['concurrency']['cancel-in-progress'] == 'false'
assert 'github.run_id' in policy['concurrency']['group']
assert len(policy['jobs']) == 1
job = policy['jobs']['observations']
assert job['runs-on'] == 'macos-26' and int(job['timeout-minutes']) <= 10
steps = job['steps']
assert steps[0]['uses'] == 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
assert steps[0]['with']['persist-credentials'] == 'false'
assert steps[-1]['uses'] == 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9'
assert 'always()' in steps[-1]['if']
assert int(steps[-1]['with']['retention-days']) <= 7
assert 'secrets.' not in workflow.read_text()
results.append({'workflow_policy': 'validated', 'manual_only': True, 'jobs': 1})
original = folder / 'research-original.py'
provenance = json.loads((folder / 'provenance.json').read_text())
assert hashlib.sha256(original.read_bytes()).hexdigest() == provenance['source_hashes']['native-vnode-probe.py']

if sys.platform != 'darwin':
    nonexistent = folder / 'must-not-create-native-root'
    assert not nonexistent.exists()
    command = [sys.executable, '-B', str(probe), '--root', str(nonexistent)]
    completed = subprocess.run(command, capture_output=True, text=True)
    results.append({'argv': command, 'exit_code': completed.returncode,
                    'stdout': completed.stdout, 'stderr': completed.stderr})
    assert completed.returncode == 77
    assert json.loads(completed.stdout)['status'] == 'UNEXECUTED_NATIVE_REQUIRED'
    assert not nonexistent.exists()

print(json.dumps({'status': 'PREPARATION_CHECKS_ONLY', 'native_executed': False,
                  'actionlint_sha256': pinned_hash, 'results': results,
                  'hashes': {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest()
                             for path in [probe, workflow, original, folder / 'provenance.json',
                                          folder / 'research-to-experiment.patch', Path(__file__)]}}, indent=2))
