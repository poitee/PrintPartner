import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/desktop-native-macos.yml'
STEP = '      - name: Verify source Unicode and case regressions on macOS\n'
ROWS = 'id,name\n1,disposable fixture\n'
TOOLS = r'''
import json, os, pathlib, plistlib, subprocess, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['RUNNER_TEMP'])
native = os.environ['NATIVE'] == '1'
if name in ('lsof', 'sleep') or (name == 'hdiutil' and args[0] == 'detach'):
    with (root / 'trace').open('a') as trace:
        trace.write(json.dumps([name, *args]) + '\n')
if name == 'cargo':
    rows = pathlib.Path(os.environ['TMPDIR']) / 'rows.csv'
    rows.write_text('id,name\n1,disposable fixture\n')
    if native:
        ready = root / 'ready'
        code = """
import fcntl, pathlib, sys, time
root = pathlib.Path(sys.argv[2]).parent
with open(sys.argv[1]) as fixture:
    fcntl.flock(fixture, fcntl.LOCK_EX)
    pathlib.Path(sys.argv[2]).touch()
    deadline = time.monotonic() + 120
    while not (root / 'release').exists():
        if time.monotonic() >= deadline:
            raise SystemExit('holder release timed out')
        time.sleep(.01)
(root / 'closed').touch()
"""
        child = subprocess.Popen([sys.executable, '-c', code, str(rows), str(ready)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        (root / 'holder.pid').write_text(str(child.pid))
        for _ in range(500):
            if ready.exists():
                break
            time.sleep(.01)
        else:
            raise SystemExit('holder did not open fixture')
    raise SystemExit(int(os.environ['TEST_STATUS']))
if native:
    if name == 'hdiutil' and '-force' in args:
        assert (root / 'closed').exists(), 'holder was not closed before force'
        print('force requested', flush=True)
    status = subprocess.call([json.loads(os.environ['REAL_TOOLS'])[name], *args])
    if name == 'hdiutil' and '-force' in args and status:
        real = json.loads(os.environ['REAL_TOOLS'])
        image_path = pathlib.Path(args[-1]).parent / 'fixtures.sparseimage'
        info = subprocess.run([real['hdiutil'], 'info', '-plist'],
                              stdout=subprocess.PIPE, timeout=10)
        if info.returncode == 0:
            images = plistlib.loads(info.stdout).get('images', [])
            for image in images:
                if pathlib.Path(image['image-path']).resolve() != image_path.resolve():
                    continue
                print('Owned image after failed force:', image, flush=True)
                devices = [item['dev-entry'] for item in image.get('system-entities', [])
                           if 'dev-entry' in item]
                subprocess.run([real['lsof'], '-nP', str(image_path), *devices], timeout=10)
        subprocess.run(['ps', '-p', (root / 'holder.pid').read_text(),
                        '-o', 'pid,ppid,state,command'], timeout=10)
    if name == 'lsof' and status == 0:
        (root / 'release').touch()
        deadline = time.monotonic() + 10
        while not (root / 'closed').exists():
            if time.monotonic() >= deadline:
                raise SystemExit('holder did not close fixture')
            time.sleep(.01)
    raise SystemExit(status)
if name == 'hdiutil':
    if args[0] == 'create':
        pathlib.Path(args[-1]).write_text('disposable image\n')
    elif args[0] == 'detach':
        if '-force' in args:
            raise SystemExit(int(os.environ['FORCE_STATUS']))
        counter = root / 'attempts'
        attempt = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(attempt))
        raise SystemExit(0 if attempt == int(os.environ['DETACH_SUCCEEDS']) else 16)
elif name == 'lsof':
    print('holder 4242 fixture rows.csv', flush=True)
    if os.environ['LSOF_STATUS'] != '0':
        print('lsof: diagnostic refused', file=sys.stderr)
    raise SystemExit(int(os.environ['LSOF_STATUS']))
'''


def workflow_body():
    step = WORKFLOW.read_text().split(STEP, 1)[1].split('\n      - ', 1)[0]
    body = step.split('        run: |\n', 1)[1]
    assert all(not line.strip() or line.startswith('          ') for line in body.splitlines())
    return textwrap.dedent(body)


class CleanupTest(unittest.TestCase):
    def run_step(self, *, status=0, succeeds=0, diagnostic=0, force=0, native=False):
        root = Path(tempfile.mkdtemp(prefix='pp image cleanup ')).resolve()
        self.addCleanup(self.remove_fixture, root, native)
        tools = root / 'bin'
        tools.mkdir()
        driver = tools / 'driver'
        driver.write_text(f'#!{sys.executable}\n' + textwrap.dedent(TOOLS))
        driver.chmod(0o755)
        real = {}
        for name in ('hdiutil', 'lsof', 'cargo', 'df', 'sleep'):
            real[name] = shutil.which(name)
            (tools / name).symlink_to(driver)
        env = dict(os.environ, RUNNER_TEMP=str(root), PATH=f'{tools}:{os.environ["PATH"]}',
                   TEST_STATUS=str(status), DETACH_SUCCEEDS=str(succeeds),
                   LSOF_STATUS=str(diagnostic), FORCE_STATUS=str(force),
                   NATIVE=str(int(native)), REAL_TOOLS=json.dumps(real))
        script = root / 'step.sh'
        script.write_text(workflow_body())
        result = subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', str(script)],
                                env=env, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=90)
        mounts = list(root.glob('pp-source-case.*/mount'))
        self.assertEqual(len(mounts), 1)
        trace = [json.loads(line) for line in (root / 'trace').read_text().splitlines()]
        return result, mounts[0], trace

    def remove_fixture(self, root, native):
        if native:
            pid = root / 'holder.pid'
            if pid.exists():
                try:
                    os.kill(int(pid.read_text()), signal.SIGTERM)
                except ProcessLookupError:
                    pass
            for mount in root.glob('pp-source-case.*/mount'):
                if os.path.ismount(mount):
                    subprocess.run(['hdiutil', 'detach', '-force', str(mount)], check=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
                self.assertFalse(os.path.ismount(mount))
        shutil.rmtree(root)

    def retries(self, mount, count=3):
        trace = []
        for attempt in range(count):
            trace.append(['hdiutil', 'detach', str(mount)])
            if attempt < count - 1:
                trace.append(['sleep', '2'])
        return trace

    def forced_trace(self, mount):
        return self.retries(mount) + [
            ['lsof', '+f', '--', str(mount)],
            ['hdiutil', 'detach', '-force', str(mount)],
        ]

    def diagnostic_output(self, mount):
        return (f'Open files on owned test fixture at {mount} before forced detach:\n'
                'holder 4242 fixture rows.csv\n')

    def assert_preserved(self, mount):
        self.assertEqual((mount / 'tmp/rows.csv').read_text(), ROWS)
        self.assertEqual((mount.parent / 'fixtures.sparseimage').read_text(), 'disposable image\n')

    def test_busy_image_records_holder_before_force(self):
        result, mount, trace = self.run_step()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(trace, self.forced_trace(mount))
        self.assertEqual(result.stdout, self.diagnostic_output(mount))
        self.assert_preserved(mount)

    def test_cleanup_preserves_failed_test_status(self):
        result, mount, trace = self.run_step(status=23, diagnostic=7, force=9)
        self.assertEqual(result.returncode, 23)
        self.assertEqual(trace, self.forced_trace(mount))
        self.assertEqual(result.stdout, self.diagnostic_output(mount)
                         + 'lsof: diagnostic refused\n'
                         + f'::warning::lsof found no holders or failed at {mount} (status 7)\n'
                         + f'::warning::Could not detach owned test fixture at {mount}\n')
        self.assert_preserved(mount)

    def test_cleanup_errors_preserve_successful_test_status(self):
        result, mount, trace = self.run_step(diagnostic=1, force=9)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(trace, self.forced_trace(mount))
        self.assertEqual(result.stdout, self.diagnostic_output(mount)
                         + 'lsof: diagnostic refused\n'
                         + f'::warning::lsof found no holders or failed at {mount} (status 1)\n'
                         + f'::warning::Could not detach owned test fixture at {mount}\n')
        self.assert_preserved(mount)

    def test_normal_detach_never_lists_holders_or_forces(self):
        for attempt in (1, 2, 3):
            with self.subTest(attempt=attempt):
                result, mount, trace = self.run_step(status=23, succeeds=attempt)
                self.assertEqual(result.returncode, 23)
                self.assertEqual(trace, self.retries(mount, attempt))
                self.assertEqual(result.stdout, '')
                self.assert_preserved(mount)

    @unittest.skipUnless(sys.platform == 'darwin', 'requires hosted macOS APFS and lsof')
    def test_native_busy_image_reports_real_holder_before_force(self):
        result, mount, trace = self.run_step(status=23, native=True)
        self.assertEqual(result.returncode, 23, result.stdout)
        self.assertEqual(trace, self.forced_trace(mount), result.stdout)
        listing = result.stdout.split(
            f'Open files on owned test fixture at {mount} before forced detach:\n', 1)[1]
        listing = listing.split('force requested\n', 1)[0]
        pid = (mount.parent.parent / 'holder.pid').read_text()
        self.assertTrue(any(line.split()[1:2] == [pid]
                            and line.endswith(str(mount / 'tmp/rows.csv'))
                            for line in listing.splitlines()), listing)
        self.assertNotIn('::warning::', result.stdout)
        self.assertFalse(os.path.ismount(mount))
        self.assertTrue((mount.parent / 'fixtures.sparseimage').is_file())


class NativeHolderProtocolTest(unittest.TestCase):
    def test_native_driver_releases_holder_after_diagnostic_before_force(self):
        with tempfile.TemporaryDirectory(prefix='pp holder protocol ') as directory:
            root = Path(directory)
            driver = root / 'driver'
            driver.write_text(textwrap.dedent(TOOLS))
            for name in ('cargo', 'lsof', 'hdiutil'):
                (root / name).symlink_to(driver)
            rows = root / 'rows.csv'
            probe = root / 'probe.py'
            probe.write_text(textwrap.dedent('''
                import fcntl, sys
                with open(sys.argv[-1]) as fixture:
                    try:
                        fcntl.flock(fixture, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        held = False
                    except BlockingIOError:
                        held = True
                assert held == (sys.argv[1] == 'held'), sys.argv
                print(sys.argv[1], flush=True)
            '''))
            real = {}
            for name, expected in (('lsof', 'held'), ('hdiutil', 'closed')):
                tool = root / f'real-{name}'
                tool.write_text(f'#!{sys.executable}\nimport subprocess, sys\n'
                                f'sys.exit(subprocess.call({[sys.executable, str(probe), expected]!r}'
                                ' + sys.argv[1:]))\n')
                tool.chmod(0o755)
                real[name] = str(tool)
            env = dict(os.environ, RUNNER_TEMP=directory, TMPDIR=directory,
                       NATIVE='1', TEST_STATUS='23', REAL_TOOLS=json.dumps(real))

            def run(name, *args):
                return subprocess.run([sys.executable, str(root / name), *args], env=env,
                                      text=True, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, timeout=15)

            try:
                result = run('cargo')
                self.assertEqual(result.returncode, 23, result.stdout)
                self.assertFalse((root / 'closed').exists())
                result = run('lsof', str(rows))
                self.assertEqual((result.returncode, result.stdout), (0, 'held\n'))
                self.assertTrue((root / 'closed').exists())
                result = run('hdiutil', 'detach', '-force', str(rows))
                self.assertEqual((result.returncode, result.stdout),
                                 (0, 'force requested\nclosed\n'))
                self.assertEqual(rows.read_text(), ROWS)
            finally:
                pid = root / 'holder.pid'
                if pid.exists():
                    try:
                        os.kill(int(pid.read_text()), signal.SIGTERM)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
