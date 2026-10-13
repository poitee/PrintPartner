"""Exercise the CI guard against a real Rust test executable."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RustTestCountTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="pp-test-count-")
        cls.root = Path(cls.temporary.name)
        source = cls.root / "fixture.rs"
        source.write_text("""
#[test] fn required_test() { assert_eq!(1 + 1, 2); }
#[test] #[ignore] fn ignored_test() { panic!("must not execute"); }
#[test] fn failing_test() { panic!("deliberate failure"); }
""")
        cls.binary = cls.root / "fixture"
        subprocess.run(["rustc", "--test", str(source), "-o", str(cls.binary)], check=True)
        cls.checker = Path(__file__).with_name("check-rust-test-count.py")

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_guard(self, selector, expected=None, prefix=""):
        execution = subprocess.run(
            [str(self.binary), selector, "--exact"], capture_output=True, text=True
        )
        log = self.root / "test.log"
        log.write_text(prefix + execution.stdout)
        command = [sys.executable, str(self.checker), str(log)]
        if expected is not None:
            command.extend(["--exact", expected])
        guard = subprocess.run(command, capture_output=True, text=True)
        return execution, guard

    def test_named_test_executes(self):
        execution, guard = self.run_guard("required_test", "required_test")
        self.assertEqual(execution.returncode, 0)
        self.assertEqual(guard.returncode, 0, guard.stderr)
        self.assertEqual(guard.stdout, "Verified 1 passed Rust test(s)\n")

    def test_obsolete_selector_fails_even_when_rust_succeeds(self):
        execution, guard = self.run_guard("obsolete_test", "obsolete_test")
        self.assertEqual(execution.returncode, 0)
        self.assertEqual(guard.returncode, 1)
        self.assertIn("did not execute exactly once", guard.stderr)

    def test_wrong_test_name_fails(self):
        _, guard = self.run_guard("required_test", "another_test")
        self.assertEqual(guard.returncode, 1)

    def test_ignored_test_fails(self):
        execution, guard = self.run_guard("ignored_test", "ignored_test")
        self.assertEqual(execution.returncode, 0)
        self.assertEqual(guard.returncode, 1)

    def test_failed_test_fails(self):
        execution, guard = self.run_guard("failing_test", "failing_test")
        self.assertNotEqual(execution.returncode, 0)
        self.assertEqual(guard.returncode, 1)

    def test_empty_suite_fails(self):
        execution, guard = self.run_guard("obsolete_test")
        self.assertEqual(execution.returncode, 0)
        self.assertEqual(guard.returncode, 1)
        self.assertIn("executed zero tests", guard.stderr)

    def test_suite_with_executed_test_passes(self):
        _, guard = self.run_guard("required_test")
        self.assertEqual(guard.returncode, 0, guard.stderr)

    def test_previous_success_cannot_hide_missing_selected_test(self):
        previous = subprocess.run(
            [str(self.binary), "required_test", "--exact"], capture_output=True, text=True
        ).stdout
        _, guard = self.run_guard("obsolete_test", "required_test", prefix=previous)
        self.assertEqual(guard.returncode, 1)


if __name__ == "__main__":
    unittest.main()
