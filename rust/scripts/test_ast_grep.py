"""Exercise the real ast-grep ratchet, including file and crate exemptions."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


RUST = Path(__file__).resolve().parents[1]


class RatchetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pp-ast-grep-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copy(RUST / "sgconfig.yml", self.root)
        shutil.copytree(RUST / "rules", self.root / "rules")
        script = self.root / "scripts" / "check-ast-grep.py"
        script.parent.mkdir()
        shutil.copy(RUST / "scripts" / "check-ast-grep.py", script)
        self.source("pp-source/src/lib.rs", "fn production() { value.unwrap(); }")
        self.baseline(unwrap=1)

    def source(self, path, text):
        file = self.root / "crates" / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def baseline(self, unwrap=0, command=0):
        (self.root / "ast-grep-baseline.json").write_text(json.dumps({
            "no-unwrap-expect": unwrap,
            "runtime-process-command": command,
        }))

    def check(self):
        return subprocess.run(
            ["python3", str(self.root / "scripts" / "check-ast-grep.py")],
            text=True,
            capture_output=True,
        )

    def test_existing_hits_and_decreases_pass(self):
        self.assertEqual(self.check().returncode, 0)
        self.source("pp-source/src/lib.rs", "fn production() {}")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("no-unwrap-expect: 0 hits (baseline 1)", result.stdout)

    def test_new_unwrap_fails(self):
        self.source("pp-source/src/lib.rs", "fn production() { value.unwrap(); value.unwrap(); }")
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("no-unwrap-expect: 2 hits (baseline 1)", result.stdout)
        self.assertIn("crates/pp-source/src/lib.rs:1: no-unwrap-expect", result.stdout)

    def test_unit_and_integration_tests_are_exempt_from_unwrap_rule(self):
        self.source("pp-source/src/lib.rs", '#[cfg(test)] mod tests { fn helper() { value.unwrap(); } }')
        self.source("pp-source/tests/case.rs", 'fn helper() { value.expect("fixture"); }')
        self.baseline()
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_command_is_allowed_only_in_runtime_crates(self):
        for crate in ("pp-core", "pp-compat", "pp-desktop"):
            self.source(f"{crate}/src/lib.rs", 'use std::process::Command;')
        self.assertEqual(self.check().returncode, 0)
        self.source("pp-net/src/lib.rs", 'use std::{process::{Command as Spawn, id}};')
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("runtime-process-command: 1 hits (baseline 0)", result.stdout)

    def test_command_in_non_runtime_integration_tests_is_baselined(self):
        self.source("pp-source/tests/case.rs", 'use std::process::Command;')
        self.assertEqual(self.check().returncode, 1)
        self.baseline(unwrap=1, command=1)
        self.assertEqual(self.check().returncode, 0)

    def test_invalid_rules_fail_closed(self):
        (self.root / "rules" / "broken.yml").write_text("not a rule")
        result = self.check()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("ast-grep ratchet error:", result.stderr)


if __name__ == "__main__":
    unittest.main()
