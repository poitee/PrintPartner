import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, required=True)
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--stage', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
source = args.repo / 'rust/scripts/native-process-probe.py'
tree = ast.parse(source.read_text(), filename=str(source))
tree.body = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef))]
namespace = {}
exec(compile(tree, str(source), 'exec'), namespace)
with tempfile.TemporaryDirectory(prefix='gre353-live-') as temporary:
    data = Path(temporary) / 'data'
    environment = dict(os.environ, LIBGL_ALWAYS_SOFTWARE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1',
        XDG_DATA_HOME=str(Path(temporary) / 'xdg-data'), XDG_CACHE_HOME=str(Path(temporary) / 'xdg-cache'))
    command = [str(args.binary.resolve()), '--dev-stage', str(args.stage.resolve()),
        '--data', str(data), '--test-exit-seconds', '3']
    process = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=90)
    (args.output / 'stdout.log').write_text(process.stdout)
    (args.output / 'stderr.log').write_text(process.stderr)
    receipt, window = namespace['validate'](process.returncode, process.stdout, process.stderr, data)
    result = {'result': 'PASS', 'proof_class': 'native_linux_unsigned_process_direct_launch',
        'source_head': subprocess.check_output(['git', '-C', str(args.repo), 'rev-parse', 'HEAD'], text=True).strip(),
        'validator_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'binary_sha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
        'manifest_sha256': hashlib.sha256((args.stage / 'bundle-manifest.json').read_bytes()).hexdigest(),
        'stage_commit': json.loads((args.stage / 'release.json').read_text())['commit'],
        'exit_code': process.returncode, 'shutdown': receipt, 'native_window': window,
        'owner_marker_absent': not (data / '.desktop-owner.json').exists(),
        'rendered_ui': False, 'macos': False, 'sdk_isolation_wrapper': False}
    (args.output / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
