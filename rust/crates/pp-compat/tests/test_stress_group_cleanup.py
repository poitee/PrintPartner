import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TARGETS = (
    "tests::separate_group_child_dies_with_force_killed_parent",
    "tests::ticket_t_3_drain_reaps_group_when_leader_wait_fails",
)
PASS = (
    f"test {TARGETS[0]} ... \n\nok\n"
    f"test {TARGETS[1]} ... ok\n"
    "test result: ok. 82 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 31.23s\n"
)


class StressOutputTests(unittest.TestCase):
    def run_output(self, output, exit_code=0, ignored=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "libtest"
            tests = [
                *TARGETS, *(f"filler::case_{i}" for i in range(80)),
                "ignored::one", "ignored::two",
            ]
            ignored = ["ignored::one", "ignored::two"] if ignored is None else ignored
            binary.write_text(
                f"#!{sys.executable}\n"
                "import sys\n"
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
                    sys.executable,
                    str(Path(__file__).with_name("stress-group-cleanup.py")),
                    "--binary", str(binary), "--scope", "suite", "--runs", "1",
                    "--burners", "0", "--cpus", "1", "--evidence", str(root / "logs"),
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )

    def test_interleaved_status_lines_accept_a_successful_unfiltered_suite(self):
        result = self.run_output(PASS)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS scope=suite runs=1/1", result.stdout)

    def test_nonzero_libtest_exit_still_fails(self):
        result = self.run_output(PASS, exit_code=101)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL run=1", result.stdout)

    def test_nested_status_lines_cannot_hide_a_filtered_root_suite(self):
        output = PASS + (
            f"test {TARGETS[0]} ... ok\n"
            "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 84 filtered out; finished in 0.00s\n"
        )
        result = self.run_output(output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAIL run=1", result.stdout)

    def test_an_ignored_target_is_rejected_before_running(self):
        result = self.run_output(PASS, ignored=[TARGETS[0], "ignored::two"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("required tests are missing or ignored: " + TARGETS[0], result.stderr)


if __name__ == "__main__":
    unittest.main()
