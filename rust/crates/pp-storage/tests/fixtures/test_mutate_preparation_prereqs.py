import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


RUNNER = Path(__file__).with_name('mutate-preparation-prereqs.py')


def load_runner():
    spec = importlib.util.spec_from_file_location('mutate_preparation_prereqs', RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MutationAnchorsTests(unittest.TestCase):
    def setUp(self):
        with patch('subprocess.run') as run, patch('tempfile.TemporaryDirectory') as temporary:
            self.runner = load_runner()
        run.assert_not_called()
        temporary.assert_not_called()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.rust = Path(self.directory.name) / 'rust'
        self.script = self.rust / RUNNER.relative_to(self.runner.rust)
        self.script.parent.mkdir(parents=True)
        shutil.copyfile(RUNNER, self.script)
        self.originals = {}
        for _, path, _, _ in self.runner.mutants:
            if path not in self.originals:
                target = self.rust / path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(self.runner.rust / path, target)
                self.originals[path] = target.read_bytes()

    def run_cli(self, *args):
        before = {path: (self.rust / path).read_bytes()
                  for path in self.originals if (self.rust / path).exists()}
        result = subprocess.run(
            [sys.executable, '-B', str(self.script), *args],
            env={**os.environ, 'PATH': ''}, cwd=self.directory.name,
            capture_output=True, text=True, timeout=10,
        )
        self.assertFalse((self.rust / 'target').exists())
        self.assertEqual(before, {path: (self.rust / path).read_bytes()
                                  for path in before})
        self.assertEqual(set(before), {path for path in self.originals
                                       if (self.rust / path).exists()})
        return result

    def test_check_valid_anchors_without_cargo_or_target(self):
        result = self.run_cli('--check-anchors')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'Validated 17 mutation anchors\n')
        self.assertEqual(result.stderr, '')

    def test_missing_and_duplicate_anchors_fail_before_setup(self):
        for index in (0, -1):
            name, path, anchor, _ = self.runner.mutants[index]
            original = self.originals[path].decode()
            for count, text in ((0, original.replace(anchor, '')),
                                (2, original + '\n' + anchor)):
                for args in (('--check-anchors',), ()):
                    with self.subTest(mutant=name, count=count, args=args):
                        (self.rust / path).write_text(text)
                        result = self.run_cli(*args)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn(f'{name}: {path}: expected 1 anchor occurrence, found {count}',
                                      result.stderr)
                        (self.rust / path).write_bytes(self.originals[path])

    def test_missing_file_reports_mutant_path_and_zero_count(self):
        name, path, _, _ = self.runner.mutants[-1]
        (self.rust / path).unlink()
        result = self.run_cli('--check-anchors')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f'{name}: {path}: expected 1 anchor occurrence, found 0 (missing file)',
                      result.stderr)

    def test_default_run_kills_mutants_and_restores_scratch(self):
        self.check_default_run(100, 'FAIL [preparation_tests]', None)

    def test_default_run_restores_scratch_on_command_error(self):
        self.check_default_run(1, 'command error', 'command error')

    def check_default_run(self, returncode, output, error):
        directory = self.rust / 'target' / 'scratch'
        directory.mkdir(parents=True)
        scratch = directory / 'rust'
        calls = []

        def run(command, **kwargs):
            self.assertEqual(command, [
                'cargo', 'nextest', 'run', '--locked', '--manifest-path',
                str(scratch / 'Cargo.toml'), '-p', 'pp-storage', '--features',
                'desktop_rebuild', '--lib', '-E', 'test(preparation_tests)', '--test-threads=2',
            ])
            self.assertEqual(kwargs['env']['CARGO_TARGET_DIR'],
                             str(self.rust / 'target/preparation-mutants-target'))
            expected = dict(self.originals)
            if calls:
                _, path, before, after = self.runner.mutants[len(calls) - 1]
                expected[path] = expected[path].decode().replace(before, after).encode()
            self.assertEqual(expected, {path: (scratch / path).read_bytes()
                                        for path in self.originals})
            calls.append(command)
            return subprocess.CompletedProcess(command, returncode if len(calls) > 1 else 0,
                                               output, '')

        with patch.object(self.runner, 'rust', self.rust), \
                patch.object(sys, 'argv', [str(self.script)]), \
                patch.object(self.runner.tempfile, 'TemporaryDirectory',
                             return_value=contextlib.nullcontext(str(directory))), \
                patch.object(self.runner.subprocess, 'run', side_effect=run), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            if error:
                with self.assertRaisesRegex(SystemExit, error):
                    self.runner.main()
            else:
                self.runner.main()
                self.assertIn('17/17 mutants killed', stdout.getvalue())
        self.assertEqual(len(calls), 2 if error else 18)
        for path, original in self.originals.items():
            self.assertEqual((scratch / path).read_bytes(), original)
            self.assertEqual((self.rust / path).read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
