"""Prove the pinned scanner detects unused dependencies without building crates."""

import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest


@unittest.skipUnless(shutil.which("cargo-machete"), "cargo-machete is not installed")
class CargoMacheteTests(unittest.TestCase):
    def scan(self, source, metadata=""):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src").mkdir()
            (root / "src/lib.rs").write_text(source)
            (root / "Cargo.toml").write_text(
                '[package]\nname = "readiness-probe"\nversion = "0.0.0"\n'
                '[dependencies]\nserde = "=1.0.228"\n' + metadata
            )
            return subprocess.run(
                ["cargo-machete", str(root)], capture_output=True, text=True, check=False
            )

    def test_used_dependency_passes(self):
        result = self.scan("pub use serde::Serialize;\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_unused_dependency_fails(self):
        result = self.scan("pub fn probe() {}\n")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("serde", result.stdout)

    def test_documented_false_positive_can_be_ignored(self):
        result = self.scan(
            "pub fn probe() {}\n",
            '[package.metadata.cargo-machete]\nignored = ["serde"]\n',
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
