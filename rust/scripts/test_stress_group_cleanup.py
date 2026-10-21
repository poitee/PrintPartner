import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TARGETS = (
    "tests::separate_group_child_dies_with_force_killed_parent",
    "tests::ticket_t_3_drain_reaps_group_when_leader_wait_fails",
)
SUBREAPER = "tests::ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced"
RUNNER = Path(__file__).with_name("stress-group-cleanup.py")
PASS = (
    f"test {TARGETS[0]} ... \n\nok\n"
    f"test {TARGETS[1]} ... ok\n"
    "test result: ok. 82 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 31.23s\n"
)


class StressOutputTests(unittest.TestCase):
    def run_output(self, output, exit_code=0, ignored=None, scope="suite"):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.logs = root / "logs"
        self.calls = root / "calls.jsonl"
        binary = root / "libtest"
        tests = [
            *TARGETS, SUBREAPER, *(f"filler::case_{i}" for i in range(79)),
            "ignored::one", "ignored::two",
        ]
        ignored = ["ignored::one", "ignored::two"] if ignored is None else ignored
        binary.write_text(
            f"#!{sys.executable}\n"
            "import json, sys\n"
            "from pathlib import Path\n"
            f"with Path({str(self.calls)!r}).open('a') as calls:\n"
            "    calls.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            f"tests = {tests!r}\n"
            f"ignored = {ignored!r}\n"
            "if '--list' in sys.argv:\n"
            "    names = ignored if '--ignored' in sys.argv else tests\n"
            "    print('\\n'.join(name + ': test' for name in names))\n"
            "else:\n"
            f"    print({output!r}, end='')\n"
            f"    sys.exit({exit_code})\n"
        )
        binary.chmod(0o700)
        return subprocess.run(
            [
                sys.executable, str(RUNNER),
                "--binary", str(binary), "--scope", scope, "--runs", "1",
                "--burners", "0", "--cpus", "1", "--evidence", str(self.logs),
            ],
            capture_output=True, text=True, timeout=10,
        )

    def test_interleaved_status_lines_accept_a_successful_unfiltered_suite(self):
        result = self.run_output(PASS)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS scope=suite runs=1/1", result.stdout)

    def test_stress_runner_propagates_failed_child_status(self):
        for status in (1, 2, 101):
            with self.subTest(child_status=status):
                result = self.run_output(PASS, exit_code=status)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(f"FAIL run=1 exit={status} summary_valid=True", result.stdout)
                self.assertEqual((self.logs / "001-0.log").read_text(), PASS)
                self.assertTrue((self.logs / "failure-processes.log").is_file())
                self.assertNotIn("PASS scope=", result.stdout)

    def test_nested_status_lines_cannot_hide_a_filtered_root_suite(self):
        output = PASS + (
            f"test {TARGETS[0]} ... ok\n"
            "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 84 filtered out; finished in 0.00s\n"
        )
        result = self.run_output(output)
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL run=1", result.stdout)

    def test_an_ignored_target_is_rejected_before_running(self):
        result = self.run_output(PASS, ignored=[TARGETS[0], "ignored::two"])
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.logs.exists())
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)
        self.assertIn("required tests are missing or ignored: " + TARGETS[0], result.stderr)

    def test_scope_routes_the_same_libtest_commands(self):
        commands = {
            "alone": [["--exact", target, "--nocapture"] for target in TARGETS],
            "pair": [[TARGETS[1], SUBREAPER, "--nocapture", "--test-threads=2"]],
            "suite": [["--nocapture", "--test-threads=12"]],
        }
        for scope, passed in (("alone", 1), ("pair", 2), ("suite", 82)):
            with self.subTest(scope=scope):
                output = PASS if scope == "suite" else (
                    f"test result: ok. {passed} passed; 0 failed; 0 ignored; "
                    "0 measured; 0 filtered out; finished in 0.00s\n"
                )
                result = self.run_output(output, scope=scope)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(
                    [json.loads(line) for line in self.calls.read_text().splitlines()],
                    [["--list"], ["--list", "--ignored"], *commands[scope]],
                )
                self.assertEqual(len(list(self.logs.glob("*.log"))), len(commands[scope]))

    def test_self_test_entrypoint_preserves_unittest_failure_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runner = root / RUNNER.name
            shutil.copyfile(RUNNER, runner)
            tests = root / "test_stress_group_cleanup.py"
            for expected in (True, False):
                with self.subTest(success=expected):
                    tests.write_text(
                        "import unittest\n"
                        "class Fixture(unittest.TestCase):\n"
                        f"    def test_status(self): self.assertTrue({expected!r})\n"
                    )
                    result = subprocess.run(
                        [sys.executable, "-B", str(runner), "--self-test"],
                        cwd=root, capture_output=True, text=True, timeout=10,
                    )
                    self.assertEqual(result.returncode, 0 if expected else 1, result.stderr)
                    self.assertIn("Ran 1 test", result.stderr)
            tests.unlink()
            result = subprocess.run(
                [sys.executable, "-B", str(runner), "--self-test"],
                cwd=root, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("FAIL: no stress runner self-tests found", result.stderr)


if __name__ == "__main__":
    unittest.main()
