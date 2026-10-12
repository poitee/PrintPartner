import subprocess
import sys
import unittest
from pathlib import Path


HELPER = Path(__file__).resolve().parent / "verify.py"
EXPECTED_ROOT = Path(
    subprocess.check_output(
        ["git", "-C", str(HELPER.parent), "rev-parse", "--show-toplevel"],
        text=True,
        timeout=15,
    ).strip()
)


def checkout_line_from_foreign_cwd():
    proc = subprocess.Popen(
        [sys.executable, str(HELPER)],
        cwd="/tmp",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        for _ in range(20):
            line = proc.stdout.readline()
            if not line:
                break
            if line.startswith("Rust verification checkout:"):
                return line.strip()
        return None
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if proc.stdout:
            proc.stdout.close()


class VerifyRepoRootTests(unittest.TestCase):
    def test_default_repo_from_foreign_cwd(self):
        line = checkout_line_from_foreign_cwd()
        self.assertEqual(
            line,
            f"Rust verification checkout: {EXPECTED_ROOT}",
        )

    def test_explicit_repo_overrides_default(self):
        proc = subprocess.run(
            [sys.executable, str(HELPER), "--repo", "/tmp"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("rust/ not found", proc.stderr + proc.stdout)


if __name__ == "__main__":
    unittest.main()
