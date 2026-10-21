import json
import re
import shlex
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
REPOSITORY = RUNNER.parents[2]
OPERATING_DOC = REPOSITORY / "rust/crates/pp-compat/tests/process-group-cleanup.md"
PASS = (
    f"test {TARGETS[0]} ... \n\nok\n"
    f"test {TARGETS[1]} ... ok\n"
    "test result: ok. 82 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 31.23s\n"
)


def summary(passed):
    return (
        f"test result: ok. {passed} passed; 0 failed; 0 ignored; "
        "0 measured; 0 filtered out; finished in 0.00s\n"
    )


class StressOutputTests(unittest.TestCase):
    def fake_libtest(self, output, exit_code=0, ignored=None):
        """Write a fake libtest binary; a dict output maps exact argv lists to output."""
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.root = root
        self.logs = root / "logs"
        self.calls = root / "calls.jsonl"
        binary = root / "libtest"
        default, outputs = (output, {}) if isinstance(output, str) else (None, {
            json.dumps(argv): text for argv, text in output
        })
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
            f"    output = {outputs!r}.get(json.dumps(sys.argv[1:]), {default!r})\n"
            "    if output is None:\n"
            "        sys.exit(3)\n"
            "    print(output, end='')\n"
            f"    sys.exit({exit_code})\n"
        )
        binary.chmod(0o700)
        return binary

    def run_output(self, output, exit_code=0, ignored=None, scope="suite"):
        binary = self.fake_libtest(output, exit_code, ignored)
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
                output = PASS if scope == "suite" else summary(passed)
                result = self.run_output(output, scope=scope)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(
                    [json.loads(line) for line in self.calls.read_text().splitlines()],
                    [["--list"], ["--list", "--ignored"], *commands[scope]],
                )
                self.assertEqual(len(list(self.logs.glob("*.log"))), len(commands[scope]))

    def documented_commands(self, exit_code):
        """Yield each documented soak command with fixture paths and two unloaded runs."""
        commands = [
            line for line in OPERATING_DOC.read_text().splitlines()
            if line.startswith("python3 rust/scripts/stress-group-cleanup.py --binary")
        ]
        self.assertEqual(len(commands), 3)
        outputs = [
            *((["--exact", target, "--nocapture"], summary(1)) for target in TARGETS),
            ([TARGETS[1], SUBREAPER, "--nocapture", "--test-threads=2"], summary(2)),
            (["--nocapture", "--test-threads=12"], PASS),
        ]
        for command in commands:
            binary = self.fake_libtest(outputs, exit_code=exit_code)
            argv = [
                str(binary) if word == "<binary>"
                else str(self.root / word.removeprefix("<evidence>/")) if word.startswith("<evidence>/")
                else word
                for word in shlex.split(command)
            ]
            self.assertEqual(argv[:2], ["python3", "rust/scripts/stress-group-cleanup.py"])
            scope = argv[argv.index("--scope") + 1]
            evidence = Path(argv[argv.index("--evidence") + 1])
            self.assertEqual(evidence, self.root / scope)
            with self.subTest(scope=scope):
                result = subprocess.run(
                    [sys.executable, *argv[1:], "--runs", "2", "--burners", "0"],
                    cwd=REPOSITORY, capture_output=True, text=True, timeout=20,
                )
                yield scope, evidence, result

    def test_documented_stress_command_runs_fixture(self):
        per_run = {"alone": 2, "pair": 1, "suite": 1}
        for scope, evidence, result in self.documented_commands(exit_code=0):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertEqual(
                [
                    re.sub(r"elapsed=\d+\.\ds$", "elapsed=<s>", line)
                    for line in result.stdout.splitlines() if line.startswith("PASS ")
                ],
                [
                    f"PASS scope={scope} runs={run}/2 commands_per_run={per_run[scope]} "
                    "burners=0 elapsed=<s>"
                    for run in (1, 2)
                ],
            )
            self.assertEqual(
                sorted(path.name for path in evidence.iterdir()),
                [f"{run:03}-{index}.log" for run in (1, 2) for index in range(per_run[scope])],
            )

    def test_documented_stress_command_propagates_failure(self):
        for scope, evidence, result in self.documented_commands(exit_code=101):
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("FAIL run=1 exit=101 summary_valid=True", result.stdout)
            self.assertNotIn("PASS scope=", result.stdout)
            self.assertEqual(
                sorted(path.name for path in evidence.iterdir()),
                ["001-0.log", "failure-processes.log"],
            )

    def test_self_test_with_other_arguments_is_refused_before_running(self):
        binary = self.fake_libtest(PASS)
        for argv in (
            ["--self-test", "--runs", "1"],
            ["--binary", str(binary), "--scope", "pair", "--evidence", str(self.logs), "--self-test"],
        ):
            with self.subTest(argv=argv):
                result = subprocess.run(
                    [sys.executable, "-B", str(RUNNER), *argv],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertEqual(
                    result.stderr,
                    "stress-group-cleanup.py: error: --self-test must be the only argument\n",
                )
                self.assertFalse(self.calls.exists())
                self.assertFalse(self.logs.exists())

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
