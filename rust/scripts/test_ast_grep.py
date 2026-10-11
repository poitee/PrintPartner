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

    def test_new_macro_unwrap_fails(self):
        self.source("pp-source/src/lib.rs", 'fn production() { value.unwrap(); println!("{}", value.unwrap()); }')
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("no-unwrap-expect: 2 hits (baseline 1)", result.stdout)

    def test_out_of_line_unit_test_file_conventions_are_exempt(self):
        self.source("pp-source/src/lib.rs", "#[cfg(test)] mod tests;")
        self.source("pp-source/src/tests.rs", "fn helper() { value.unwrap(); }")
        self.source("pp-net/src/nested/tests/helper.rs", "fn helper() { value.unwrap(); }")
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

    def test_raw_and_ordinary_aliases_share_provenance(self):
        for code in (
            'use std::process as r#p; fn f() { p::Command::new("sh"); }',
            'use std::process as p; fn f() { r#p::Command::new("sh"); }',
            'use std as r#s; fn f() { s::process::Command::new("sh"); }',
            'use std as s; fn f() { r#s::process::Command::new("sh"); }',
            'use std::process as r#p; fn f() { self::p::Command::new("sh"); }',
            'use std::process as p; fn f() { vec![crate::r#p::Command::new("sh")]; }',
            'use std::process as r#p; mod child { fn f() { super::p::Command::new("sh"); } }',
            'use std::process as r#p; fn f() { p::Command::new("sh"); p::Command::new("sh"); }',
        ):
            with self.subTest(code=code):
                self.source("pp-source/src/lib.rs", code)
                self.baseline()
                result = self.check()
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                count = 2 if code.count('new("sh")') == 2 else 1
                self.assertIn(f"runtime-process-command: {count} hits", result.stdout)

    def test_raw_alias_shadows_and_non_code_are_preserved(self):
        for code in (
            'use std::process as p; fn f() { use local as r#p; p::Command::new("sh"); }',
            'use std::process as r#p; trait T { type Command; } fn f<p:T>() { let _: p::Command; }',
            '#[cfg(any())] use std::process as r#p; use local as p; fn f(_: p::Command) {}',
            'use std::process as r#p; fn f() { q::Command::new("sh"); }',
            'fn f() { let _ = "r#p::Command"; /* r#p::Command */ }',
            'mod r#type {} fn f() { r#type::Command::new("sh"); }',
            'use std::process as r#p; fn f() { use other::r#p::{self}; p::Command::new("sh"); }',
        ):
            with self.subTest(code=code):
                self.source("pp-source/src/lib.rs", code)
                self.baseline()
                result = self.check()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_raw_alias_reports_original_unicode_spelling_and_line(self):
        code = 'const TEXT: &str = "é";\nuse std::process as r#p;\nfn f() { r#p::Command::new("sh"); }'
        self.source("pp-source/src/lib.rs", code)
        self.baseline()
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('crates/pp-source/src/lib.rs:3: runtime-process-command: r#p::Command', result.stdout)
        self.assertEqual((self.root / "crates/pp-source/src/lib.rs").read_text(), code)

    def test_raw_aliases_retain_runtime_crate_exemptions(self):
        for crate in ("pp-core", "pp-compat", "pp-desktop"):
            self.source(f"{crate}/src/lib.rs", 'use std::process as r#p; fn f() { p::Command::new("sh"); }')
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("runtime-process-command: 0 hits", result.stdout)

    def test_invalid_rules_fail_closed(self):
        (self.root / "rules" / "broken.yml").write_text("not a rule")
        result = self.check()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("ast-grep ratchet error:", result.stderr)

    def test_deleted_rule_fails_closed(self):
        (self.root / "rules" / "no-unwrap-expect.yml").unlink()
        result = self.check()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("unloaded=['no-unwrap-expect']", result.stderr)

    def test_disabled_rule_fails_closed(self):
        rule = self.root / "rules" / "no-unwrap-expect.yml"
        rule.write_text(rule.read_text().replace("severity: warning", "severity: off"))
        result = self.check()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("unloaded=['no-unwrap-expect']", result.stderr)

    def test_unconfigured_rules_fail_closed(self):
        (self.root / "empty-rules").mkdir()
        (self.root / "sgconfig.yml").write_text("ruleDirs:\n  - empty-rules\n")
        result = self.check()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("ast-grep ratchet error:", result.stderr)

    def test_unbaselined_rule_with_no_hits_fails_closed(self):
        (self.root / "rules" / "extra.yml").write_text(
            "id: extra-rule\nlanguage: Rust\nseverity: warning\nrule:\n  pattern: nonexistent()\n"
        )
        result = self.check()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("unbaselined=['extra-rule']", result.stderr)


if __name__ == "__main__":
    unittest.main()
