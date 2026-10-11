"""Regression checks for the native bundle gate, including real Git diffs."""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("bundle_filter", Path(__file__).with_name("macos-bundle-path-filter.py"))
bundle_filter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle_filter)


class PathFilterTests(unittest.TestCase):
    def test_exclusions_inside_native_trees(self):
        paths = ["web/apps/server/tests/unit.ts", "web/packages/contracts/__tests__/schema.ts",
                 "web/apps/server/fixtures/data.json", "rust/tests/fixtures/part.stl",
                 "web/packages/contracts/test-fixtures/schema.ts", "web/apps/client/src/App.test.tsx",
                 "web/apps/client/src/App.spec.tsx", "docs/desktop.md", "README.md",
                 "rust/README.md", "web/eslint.config.js", "web/packages/foo/.eslintrc.json",
                 ".prettierrc", "web/prettier.config.mjs", ".github/actionlint.yaml",
                 "scripts/lint-pr-evidence.mjs", "scripts/lint-pr-evidence.test.mjs",
                 "web/scripts/lint-types.mjs", ".github/workflows/lint.yml",
                 ".github/workflows/web-lint.yml", ".github/workflows/actionlint.yml"]
        for path in paths:
            with self.subTest(path=path):
                self.assertFalse(bundle_filter.is_native_input(path))

    def test_pr_194(self):
        paths = [".github/pull_request_template.md", ".github/workflows/pr-evidence-tests.yml",
                 ".github/workflows/pr-evidence.yml", "docs/contributing/gate-evidence.md",
                 "scripts/html-named-character-references.json", "scripts/lint-pr-evidence.mjs",
                 "scripts/lint-pr-evidence.test.mjs"]
        self.assertFalse(any(map(bundle_filter.is_native_input, paths)))

    def test_runtime_build_and_lock_inputs(self):
        paths = ["rust/crates/pp-compat/src/lib.rs", "rust/crates/pp-compat/tests/lifecycle.rs",
                 "rust/tauri.conf.json", "rust/build.rs", "rust/Cargo.toml", "rust/Cargo.lock",
                 "rust-toolchain.toml", "web/apps/client/src/App.tsx",
                 "web/apps/server/src/start.ts", "web/packages/contracts/src/schema.ts",
                 "web/package.json", "web/package-lock.json", "web/tsconfig.base.json",
                 "web/apps/client/vite.config.ts", "web/scripts/atomic-package-build.mjs",
                 "scripts/release.mjs", "scripts/macos-bundle-path-filter.py",
                 ".github/workflows/desktop-native-macos.yml", ".github/workflows/desktop-runtime.yml",
                 ".github/workflows/web-ci.yml", ".github/workflows/release.yml",
                 ".github/actions/build/action.yml", "Dockerfile"]
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue(bundle_filter.is_native_input(path))

    def test_git_diff_semantics(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=directory, text=True).strip()

            def commit(path):
                file = Path(directory, path)
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("proof\n")
                git("add", ".")
                git("commit", "-qm", "proof")
                return git("rev-parse", "HEAD")

            git("init", "-q")
            git("config", "user.email", "proof@example.com")
            git("config", "user.name", "Proof")
            base = commit("README.md")
            head = commit("web/apps/server/fixtures/space and\nnewline.json")
            git("checkout", "-q", "--detach", base)
            advanced_base = commit("rust/src/lib.rs")
            previous = os.getcwd()
            try:
                os.chdir(directory)
                self.assertFalse(bundle_filter.select_native("pull_request", advanced_base, head))
                self.assertTrue(bundle_filter.select_native("workflow_dispatch", base, head))
                self.assertTrue(bundle_filter.select_native("push", "0" * 40, head))
                self.assertTrue(bundle_filter.select_native("pull_request", "", head))
                self.assertTrue(bundle_filter.select_native("push", base, advanced_base))
                git("rm", "rust/src/lib.rs")
                git("commit", "-qm", "delete runtime input")
                self.assertTrue(bundle_filter.select_native("push", advanced_base, git("rev-parse", "HEAD")))
            finally:
                os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
