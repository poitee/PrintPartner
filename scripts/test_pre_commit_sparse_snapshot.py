import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / ".githooks/pre-commit"
LARGE_FILE_CHECK = ROOT / "scripts/check-large-files.py"


class PreCommitSparseSnapshotTests(unittest.TestCase):
    def test_rust_snapshot_includes_skip_worktree_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)

            hook = root / ".githooks/pre-commit"
            hook.parent.mkdir(parents=True)
            hook.write_text(HOOK.read_text())
            (root / "scripts").mkdir()
            (root / "scripts/check-large-files.py").write_text(LARGE_FILE_CHECK.read_text())

            changed = root / "rust/changed.rs"
            changed.parent.mkdir(parents=True)
            changed.write_text("pub fn changed() {}\n")
            omitted = root / "rust/omitted.rs"
            omitted.write_text("pub fn omitted() {}\n")
            subprocess.run(["git", "-C", str(root), "add", "--", "rust"], check=True)
            subprocess.run(
                ["git", "-C", str(root), "update-index", "--skip-worktree", "--", "rust/omitted.rs"],
                check=True,
            )
            omitted.unlink()

            marker = root / "cargo-saw-complete-snapshot"
            cargo = root / "bin/cargo"
            cargo.parent.mkdir()
            cargo.write_text(
                "#!/bin/sh\n"
                "manifest=\n"
                "while [ \"$#\" -gt 0 ]; do\n"
                "  if [ \"$1\" = --manifest-path ]; then shift; manifest=\"$1\"; fi\n"
                "  shift\n"
                "done\n"
                "snapshot=\"${manifest%/rust/Cargo.toml}\"\n"
                "test -f \"$snapshot/rust/omitted.rs\" || exit 41\n"
                "printf '%s\\n' \"$snapshot\" > \"$CARGO_SNAPSHOT_MARKER\"\n"
            )
            cargo.chmod(0o755)
            env = {**os.environ, "PATH": f"{cargo.parent}{os.pathsep}{os.environ['PATH']}",
                   "CARGO_SNAPSHOT_MARKER": str(marker)}

            old_hook = hook.read_text().replace("--ignore-skip-worktree-bits ", "")
            hook.write_text(old_hook)
            broken = subprocess.run(["bash", str(hook)], cwd=root, env=env,
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(broken.returncode, 0, broken.stdout)
            self.assertIn("skip-worktree", broken.stderr)
            self.assertFalse(marker.exists())

            hook.write_text(HOOK.read_text())
            fixed = subprocess.run(["bash", str(hook)], cwd=root, env=env,
                                   capture_output=True, text=True, check=False)
            self.assertEqual(fixed.returncode, 0, fixed.stderr)
            self.assertTrue(marker.is_file())


if __name__ == "__main__":
    unittest.main()
