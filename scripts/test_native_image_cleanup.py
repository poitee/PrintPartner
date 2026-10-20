import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from native_image_diagnostics import after_workflow, probe, retain


WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/desktop-native-macos.yml'
STEP = '      - name: Verify source Unicode and case regressions on macOS\n'
ROWS = 'id,name\n1,disposable fixture\n'
DEVICE = '/dev/disk42'
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
    (root / 'cargo-exit').write_text(os.environ['TEST_STATUS'])
    raise SystemExit(int(os.environ['TEST_STATUS']))
if native:
    command = [json.loads(os.environ['REAL_TOOLS'])[name], *args]
    if name == 'hdiutil' and '-force' in args:
        assert (root / 'closed').exists(), 'holder was not closed before force'
        sys.path.insert(0, os.environ['DIAGNOSTICS_MODULE'])
        from native_image_diagnostics import before_force, force_status
        before_force(root, json.loads(os.environ['REAL_TOOLS']))
        print('force requested', flush=True)
        command.insert(-1, '-verbose')
    status = subprocess.call(command)
    if name == 'hdiutil' and '-force' in args:
        force_status(root, command, status)
    if name == 'hdiutil' and args[0] in ('create', 'attach') and status:
        print(f'hdiutil {args[0]} exited with status {status}', file=sys.stderr, flush=True)
    if name == 'lsof':
        (root / 'release').touch()
        deadline = time.monotonic() + 10
        while not (root / 'closed').exists():
            if time.monotonic() >= deadline:
                raise SystemExit('holder did not close fixture')
            time.sleep(.01)
    raise SystemExit(status)
if name == 'hdiutil':
    if args[0] == os.environ.get('REFUSE_SETUP'):
        print(f'hdiutil {args[0]}: disposable setup refused', file=sys.stderr)
        raise SystemExit(int(os.environ['SETUP_STATUS']))
    if args[0] == 'create':
        pathlib.Path(args[-1]).write_text('disposable image\n')
    elif args[0] == 'attach':
        print('/dev/disk42\tGUID_partition_scheme\n/dev/disk42s1\tApple_APFS\n'
              f'/dev/disk43\tEF57347C-0000-11AA-AA11-0030654\n/dev/disk43s1\t{args[-2]}')
    elif args[0] == 'detach':
        counter = root / ('forced' if '-force' in args else 'attempts')
        attempt = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(attempt))
        if '-force' in args:
            statuses = os.environ['FORCE_STATUS'].split()
            raise SystemExit(int(statuses[min(attempt, len(statuses)) - 1]))
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
    def run_step(self, *, status=0, succeeds=0, diagnostic=0, force=0, native=False,
                 refuse_setup='', setup_status=23):
        root = Path(tempfile.mkdtemp(prefix='pp image cleanup ')).resolve()
        self.addCleanup(self.remove_fixture, root, native)
        (root / 'unowned').mkdir()
        (root / 'unowned/rows.csv').write_text(ROWS)
        (root / 'trace').touch()
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
                   REFUSE_SETUP=refuse_setup, SETUP_STATUS=str(setup_status),
                   NATIVE=str(int(native)), REAL_TOOLS=json.dumps(real),
                   DIAGNOSTICS_MODULE=str(Path(__file__).resolve().parent))
        script = root / 'step.sh'
        script.write_text(workflow_body())
        try:
            result = subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', str(script)],
                                    env=env, text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, timeout=90)
        finally:
            if native:
                try:
                    after_workflow(root, real)
                except (OSError, ValueError) as error:
                    print(f'Native diagnostic collection failed: {error}', flush=True)
                evidence = os.environ.get('PP_NATIVE_IMAGE_EVIDENCE')
                if evidence:
                    try:
                        retain(root, evidence, result.stdout if 'result' in locals()
                               else 'Workflow did not complete')
                    except OSError as error:
                        print(f'Native diagnostic retention failed: {error}', flush=True)
        cargo_exit = root / 'cargo-exit'
        if (result.returncode != status or not cargo_exit.exists()
                or cargo_exit.read_text() != str(status)):
            self.fail(f'Workflow did not reach expected cargo exit {status}; '
                      f'shell exit {result.returncode}. Combined output:\n{result.stdout}')
        mounts = list(root.glob('pp-source-case.*/mount'))
        self.assertEqual(len(mounts), 1, result.stdout)
        trace = [json.loads(line) for line in (root / 'trace').read_text().splitlines()]
        return result, mounts[0], trace

    def test_setup_refusal_reports_shell_status_and_output(self):
        for operation in ('create', 'attach'):
            for setup_status in (12, 23):
                with self.subTest(operation=operation, setup_status=setup_status):
                    with self.assertRaises(AssertionError) as failure:
                        self.run_step(status=23, refuse_setup=operation,
                                      setup_status=setup_status)
                    self.assertEqual(str(failure.exception),
                                     'Workflow did not reach expected cargo exit 23; '
                                     f'shell exit {setup_status}. Combined output:\n'
                                     f'hdiutil {operation}: disposable setup refused\n')

    def test_native_attach_refusal_survives_device_output_pipeline(self):
        with tempfile.TemporaryDirectory(prefix='pp setup refusal ') as directory:
            hdiutil = Path(directory) / 'hdiutil'
            hdiutil.write_text(f'#!{sys.executable}\n'
                               'import sys\n'
                               'if sys.argv[1] == "attach":\n'
                               '    print("disposable native attach refused", file=sys.stderr)\n'
                               '    raise SystemExit(23)\n')
            hdiutil.chmod(0o755)
            with patch.dict(os.environ, PATH=f'{directory}:{os.environ["PATH"]}'):
                with self.assertRaises(AssertionError) as failure:
                    self.run_step(status=23, native=True)
            self.assertEqual(str(failure.exception),
                             'Workflow did not reach expected cargo exit 23; '
                             'shell exit 23. Combined output:\n'
                             'disposable native attach refused\n'
                             'hdiutil attach exited with status 23\n')

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

    def retries(self, target, count=3, *flags):
        trace = []
        for attempt in range(count):
            trace.append(['hdiutil', 'detach', *flags, str(target)])
            if attempt < count - 1:
                trace.append(['sleep', '2'])
        return trace

    def forced_trace(self, mount, device=DEVICE, count=1):
        return (self.retries(mount) + [['lsof', '+f', '--', str(mount)]]
                + self.retries(device, count, '-force'))

    def diagnostic_output(self, mount):
        return (f'Open files on owned test fixture at {mount} before forced detach:\n'
                'holder 4242 fixture rows.csv\n')

    def assert_preserved(self, mount):
        self.assertEqual((mount.parent.parent / 'unowned/rows.csv').read_text(), ROWS)
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
        self.assertEqual(trace, self.forced_trace(mount, count=3))
        self.assertEqual(result.stdout, self.diagnostic_output(mount)
                         + 'lsof: diagnostic refused\n'
                         + f'::warning::lsof found no holders or failed at {mount} (status 7)\n'
                         + f'::warning::Could not detach owned test fixture at {mount}\n')
        self.assert_preserved(mount)

    def test_cleanup_errors_preserve_successful_test_status(self):
        result, mount, trace = self.run_step(diagnostic=1, force=9)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(trace, self.forced_trace(mount, count=3))
        self.assertEqual(result.stdout, self.diagnostic_output(mount)
                         + 'lsof: diagnostic refused\n'
                         + f'::warning::lsof found no holders or failed at {mount} (status 1)\n'
                         + f'::warning::Could not detach owned test fixture at {mount}\n')
        self.assert_preserved(mount)

    def test_forced_detach_retries_busy_device_without_warning(self):
        for count in (2, 3):
            with self.subTest(count=count):
                result, mount, trace = self.run_step(status=23, force='16 ' * (count - 1) + '0')
                self.assertEqual(result.returncode, 23)
                self.assertEqual(trace, self.forced_trace(mount, count=count))
                self.assertEqual(result.stdout, self.diagnostic_output(mount))
                self.assert_preserved(mount)

    def test_normal_detach_never_lists_holders_or_forces(self):
        for attempt in (1, 2, 3):
            with self.subTest(attempt=attempt):
                result, mount, trace = self.run_step(status=23, succeeds=attempt)
                self.assertEqual(result.returncode, 23)
                self.assertEqual(trace, self.retries(mount, attempt))
                self.assertEqual(result.stdout, '')
                self.assert_preserved(mount)

    def test_cleanup_function_preserves_all_exit_status_cases(self):
        for status in (0, 1, 23, 130, 255):
            for succeeds, diagnostic, force in (
                (1, 0, 0), (2, 0, 0), (3, 0, 0),
                (0, 0, 0), (0, 7, 0), (0, 0, 9), (0, 7, 9),
            ):
                with self.subTest(status=status, succeeds=succeeds,
                                  diagnostic=diagnostic, force=force):
                    result, mount, trace = self.run_step(
                        status=status, succeeds=succeeds, diagnostic=diagnostic, force=force)
                    self.assertEqual(result.returncode, status)
                    expected = ''
                    if succeeds:
                        self.assertEqual(trace, self.retries(mount, succeeds))
                    else:
                        self.assertEqual(trace, self.forced_trace(mount, count=3 if force else 1))
                        expected = self.diagnostic_output(mount)
                        if diagnostic:
                            expected += ('lsof: diagnostic refused\n'
                                         + f'::warning::lsof found no holders or failed at {mount} (status 7)\n')
                        if force:
                            expected += f'::warning::Could not detach owned test fixture at {mount}\n'
                    self.assertEqual(result.stdout, expected)
                    self.assert_preserved(mount)

    @unittest.skipUnless(shutil.which('actionlint') and shutil.which('shellcheck'),
                         'requires actionlint and shellcheck on PATH')
    def test_cleanup_function_passes_actionlint_shellcheck(self):
        body = workflow_body()
        self.assertIn('trap cleanup_source_fixture EXIT\n', body)
        self.assertIn('cleanup_source_fixture() {\n  result=$?\n', body)
        with tempfile.TemporaryDirectory(prefix='pp cleanup lint ') as directory:
            script = Path(directory) / 'step.sh'
            script.write_text(body)
            for command in (['shellcheck', '--shell=bash', str(script)],
                            ['actionlint', '-no-color', str(WORKFLOW)]):
                result = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, timeout=30)
                self.assertEqual((result.returncode, result.stdout), (0, ''))
            broken = body.replace('  result=$?', '  result=$?\n  echo $fixture_mount', 1)
            script.write_text(broken)
            workflow = Path(directory) / 'probe.yml'
            workflow.write_text('name: Cleanup analysis probe\non: push\njobs:\n'
                                '  probe:\n    runs-on: macos-latest\n    steps:\n'
                                '      - shell: bash\n        run: |\n'
                                + textwrap.indent(broken, '          '))
            for command in (['shellcheck', '--shell=bash', str(script)],
                            ['actionlint', '-no-color', str(workflow)]):
                result = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, timeout=30)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn('SC2086', result.stdout)
                self.assertIn('Double quote', result.stdout)

    @unittest.skipUnless(sys.platform == 'darwin', 'requires hosted macOS APFS and lsof')
    def test_native_busy_image_reports_real_holder_before_force(self):
        result, mount, trace = self.run_step(status=23, native=True)
        self.assertEqual(result.returncode, 23, result.stdout)
        forced = [entry for entry in trace if entry[:3] == ['hdiutil', 'detach', '-force']]
        self.assertRegex(forced[0][-1], r'^/dev/disk[0-9]+$', result.stdout)
        self.assertEqual(trace, self.forced_trace(mount, forced[0][-1], len(forced)), result.stdout)
        listing = result.stdout.split(
            f'Open files on owned test fixture at {mount} before forced detach:\n', 1)[1]
        listing = listing.split('force requested\n', 1)[0]
        pid = (mount.parent.parent / 'holder.pid').read_text()
        self.assertTrue(any(line.split()[1:2] == [pid]
                            and line.endswith(str(mount / 'tmp/rows.csv'))
                            for line in listing.splitlines()), listing)
        self.assertNotIn('::warning::', result.stdout)
        self.assertFalse(os.path.ismount(mount))
        image = (mount.parent / 'fixtures.sparseimage').resolve()
        self.assertTrue(image.is_file())
        info = subprocess.run(['hdiutil', 'info', '-plist'], check=True,
                              stdout=subprocess.PIPE, timeout=10)
        attached = [Path(entry['image-path']).resolve()
                    for entry in plistlib.loads(info.stdout).get('images', [])]
        self.assertNotIn(image, attached, result.stdout)


class NativeHolderProtocolTest(unittest.TestCase):
    def test_native_driver_releases_holder_after_diagnostic_before_force(self):
        for lsof_status in (0, 1):
            with self.subTest(lsof_status=lsof_status):
                self.drive_holder_protocol(lsof_status)

    def drive_holder_protocol(self, lsof_status):
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
            for name, expected, status in (('lsof', 'held', lsof_status), ('hdiutil', 'closed', 0)):
                tool = root / f'real-{name}'
                tool.write_text(f'#!{sys.executable}\nimport subprocess, sys\n'
                                f'sys.exit(subprocess.call({[sys.executable, str(probe), expected]!r}'
                                f' + sys.argv[1:]) or {status})\n')
                tool.chmod(0o755)
                real[name] = str(tool)
            env = dict(os.environ, RUNNER_TEMP=directory, TMPDIR=directory,
                       NATIVE='1', TEST_STATUS='23', REAL_TOOLS=json.dumps(real),
                       DIAGNOSTICS_MODULE=str(Path(__file__).resolve().parent))

            def run(name, *args):
                return subprocess.run([sys.executable, str(root / name), *args], env=env,
                                      text=True, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, timeout=15)

            try:
                result = run('cargo')
                self.assertEqual(result.returncode, 23, result.stdout)
                self.assertFalse((root / 'closed').exists())
                result = run('lsof', str(rows))
                self.assertEqual((result.returncode, result.stdout), (lsof_status, 'held\n'))
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


class NativeDiagnosticTest(unittest.TestCase):
    def test_missing_probe_executable_is_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(probe(root, 'missing', [str(root / 'absent')]), b'')
            self.assertIn('No such file', json.loads((root / 'missing.json').read_text())['error'])
            self.assertEqual(probe(root, 'later', [sys.executable, '-c', 'print("continued")']),
                             b'continued\n')

    def test_force_status_survives_timed_out_probe_and_retains_success_baseline(self):
        for status in (0, 16):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                image = root / 'pp-source-case.fixture/fixtures.sparseimage'
                image.parent.mkdir()
                image.touch()
                (root / 'closed').touch()
                (root / 'holder.pid').write_text(str(os.getpid()))
                attached = root / 'attached'
                attached.touch()
                raw = plistlib.dumps({'images': [{'image-path': str(image), 'hdid-pid': 42,
                                      'system-entities': [{'dev-entry': '/dev/disk42'}]}]})
                tools = root / 'bin'
                tools.mkdir()
                hdiutil = tools / 'real-hdiutil'
                hdiutil.write_text(f'#!{sys.executable}\nimport pathlib, sys\n'
                                   f'attached = pathlib.Path({str(attached)!r})\n'
                                   'if sys.argv[1] == "info":\n'
                                   f'    sys.stdout.buffer.write({raw!r} if attached.exists() else '
                                   f'{plistlib.dumps({"images": []})!r})\n'
                                   'else:\n'
                                   + ('    attached.unlink()\n' if status == 0 else '')
                                   + f'    raise SystemExit({status})\n')
                hdiutil.chmod(0o755)
                for name, body in (
                    ('diskutil', 'import time; print("partial diskutil", flush=True); time.sleep(4)'),
                    ('ioreg', 'print("owned disk42 open clients")'),
                    ('lsof', 'raise SystemExit(1)'),
                    ('sudo', 'print("later privileged probe")'),
                ):
                    tool = tools / name
                    tool.write_text(f'#!{sys.executable}\n{body}\n')
                    tool.chmod(0o755)
                driver = tools / 'hdiutil'
                driver.write_text(f'#!{sys.executable}\n' + textwrap.dedent(TOOLS))
                driver.chmod(0o755)
                real = {'hdiutil': str(hdiutil), 'lsof': str(tools / 'lsof')}
                env = dict(os.environ, RUNNER_TEMP=directory, NATIVE='1',
                           REAL_TOOLS=json.dumps(real), PATH=f'{tools}:{os.environ["PATH"]}',
                           DIAGNOSTICS_MODULE=str(Path(__file__).resolve().parent))
                result = subprocess.run([str(driver), 'detach', '-force', '/dev/disk42'],
                                        env=env, stdout=subprocess.PIPE, text=True, timeout=10)
                self.assertEqual((result.returncode, result.stdout), (status, 'force requested\n'))
                self.assertEqual(json.loads((root / 'diagnostics/force-status.jsonl').read_text())['status'], status)
                with patch.dict(os.environ, PATH=env['PATH']):
                    after_workflow(root, real)
                before = root / 'diagnostics/before'
                after = root / 'diagnostics/after'
                self.assertEqual(json.loads((before / 'owned.json').read_text())[0]['hdid-pid'], 42)
                self.assertEqual(len(json.loads((after / 'owned.json').read_text())), int(status != 0))
                self.assertEqual(json.loads((after / 'disk42-diskutil.json').read_text())['error'],
                                 'TimeoutExpired')
                self.assertEqual((after / 'disk42-diskutil.out').read_text(), 'partial diskutil\n')
                self.assertEqual((after / 'media-iokit.out').read_text(), 'owned disk42 open clients\n')
                self.assertEqual((after / 'system-log.out').read_text(), 'later privileged probe\n')
                holder_command = json.loads((after / 'holders.json').read_text())['command']
                self.assertEqual(holder_command[-2:], ['/dev/disk42', '/dev/rdisk42'])
                self.assertTrue((before / 'holder.json').is_file())
                self.assertTrue((after / 'holder.json').is_file())
                with tempfile.TemporaryDirectory() as evidence:
                    destination = retain(root, evidence, result.stdout)
                    shutil.rmtree(root / 'diagnostics')
                    self.assertEqual((destination / 'workflow.txt').read_text(), 'force requested\n')
                    self.assertEqual(json.loads((destination / 'trace').read_text()),
                                     ['hdiutil', 'detach', '-force', '/dev/disk42'])
                    self.assertTrue((destination / 'before/owned.json').is_file())
                    self.assertTrue((destination / 'after/system-log.json').is_file())
                (root / 'diagnostics/before').mkdir(parents=True)
                if status:
                    (root / 'diagnostics/force-status.jsonl').unlink(missing_ok=True)
                else:
                    (root / 'diagnostics/force-status.jsonl').write_text(json.dumps({
                        'command': [str(hdiutil), 'detach', '-force', '/dev/disk42'], 'status': 0
                    }) + '\n')
                with patch.dict(os.environ, PATH=env['PATH']):
                    after_workflow(root, real)
                self.assertEqual(json.loads((after / 'devices.json').read_text())['devices'],
                                 ['/dev/disk42'])
                self.assertEqual(json.loads((after / 'holders.json').read_text())['command'][-1],
                                 '/dev/rdisk42')
                if status == 0:
                    (root / 'diagnostics/force-status.jsonl').unlink()
                    with patch.dict(os.environ, PATH=env['PATH']):
                        after_workflow(root, real)
                    self.assertIn('device probes skipped',
                                  json.loads((after / 'devices.json').read_text())['note'])

    def test_corrupt_receipts_do_not_skip_device_probes(self):
        force = json.dumps({'command': ['hdiutil', 'detach', '-force', '/dev/disk42'], 'status': 16})
        for name, owned, forces, devices, unreadable in (
            ('truncated owned', '[{"system-entities": [{"dev-entry": "/dev/di', force + '\n',
             ['/dev/disk42'], ['owned.json: JSONDecodeError']),
            ('truncated force line', '[]', force + '\n{"command": ["hdiu',
             ['/dev/disk42'], ['force-status.jsonl: JSONDecodeError']),
            ('wrong shape', '{"images": []}', '{"status": 16}\n',
             [], ['owned.json: AttributeError', 'force-status.jsonl: KeyError']),
            ('invalid UTF-8', b'[\xff]', '\xff' + force + '\n',
             [], ['owned.json: UnicodeDecodeError', 'force-status.jsonl: UnicodeDecodeError']),
            ('non-string target', '[{"system-entities": [{"dev-entry": 7}]}]',
             force + '\n{"command": [null]}\n',
             ['/dev/disk42'], ['owned.json: ValueError', 'force-status.jsonl: ValueError']),
            ('unencodable target', '[{"system-entities": [{"dev-entry": "/dev/disk\\u0000"}]}]',
             force + '\n{"command": ["\\ud800"]}\n',
             ['/dev/disk42'], ['owned.json: ValueError', 'force-status.jsonl: ValueError']),
            ('empty force receipt', '[]', '', [], ['force-status.jsonl: empty']),
        ):
            with self.subTest(name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                image = root / 'pp-source-case.fixture/fixtures.sparseimage'
                image.parent.mkdir()
                image.touch()
                (root / 'diagnostics/before').mkdir(parents=True)
                (root / 'diagnostics/before/owned.json').write_bytes(
                    owned if isinstance(owned, bytes) else owned.encode())
                (root / 'diagnostics/force-status.jsonl').write_bytes(forces.encode('latin-1'))
                tools = root / 'bin'
                tools.mkdir()
                for tool, body in (
                    ('real-hdiutil', f'import sys; sys.stdout.buffer.write({plistlib.dumps({"images": []})!r})'),
                    ('real-lsof', 'print("holders")'),
                    ('diskutil', 'print("diskutil")'),
                    ('ioreg', 'print("ioreg")'),
                    ('sudo', 'print("privileged")'),
                ):
                    (tools / tool).write_text(f'#!{sys.executable}\n{body}\n')
                    (tools / tool).chmod(0o755)
                real = {'hdiutil': str(tools / 'real-hdiutil'), 'lsof': str(tools / 'real-lsof')}
                with patch.dict(os.environ, PATH=f'{tools}:{os.environ["PATH"]}'):
                    after_workflow(root, real)
                after = root / 'diagnostics/after'
                receipt = json.loads((after / 'devices.json').read_text())
                self.assertEqual(receipt['devices'], devices)
                self.assertEqual([': '.join(entry.split(': ', 2)[:2])
                                  for entry in receipt['unreadable']], unreadable)
                self.assertEqual((after / 'holders.out').read_text(), 'holders\n')
                for probe_name in ('disk42-diskutil', 'system-log'):
                    self.assertEqual((after / f'{probe_name}.json').is_file(), bool(devices))
                if devices:
                    self.assertEqual(json.loads((after / 'holders.json').read_text())['command'][-2:],
                                     ['/dev/disk42', '/dev/rdisk42'])
                    self.assertEqual((after / 'disk42-diskutil.out').read_text(), 'diskutil\n')

    def test_retention_keeps_workflow_output_after_early_failure(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as evidence:
            root = Path(directory) / 'pp image cleanup early'
            root.mkdir()
            destination = retain(root, evidence, 'hdiutil attach exited with status 23\n')
            self.assertEqual(destination, Path(evidence) / root.name)
            self.assertEqual((destination / 'workflow.txt').read_text(),
                             'hdiutil attach exited with status 23\n')
            errors = (destination / 'retention-errors.txt').read_text().splitlines()
            self.assertEqual([error.split(':', 1)[0] for error in errors], ['diagnostics', 'trace'])
            self.assertEqual(sorted(path.name for path in destination.iterdir()),
                             ['retention-errors.txt', 'workflow.txt'])


if __name__ == '__main__':
    unittest.main()
