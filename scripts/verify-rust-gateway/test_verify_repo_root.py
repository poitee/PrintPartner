import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HELPER = Path(__file__).resolve().parent / "verify.py"
VERIFY_BYTES = HELPER.read_bytes()
RISKY_MARKERS = ("verify.py", " npm ", " cargo ", "pp-server", "pp-verify-rust-")


def init_git_repo(path: Path) -> None:
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True, text=True)
    for key, value in (
        ("user.email", "gre511-test@example.com"),
        ("user.name", "gre511-test"),
    ):
        subprocess.run(
            ["git", "config", key, value],
            cwd=path,
            check=True,
            capture_output=True,
            text=True,
        )


def call_default_repo_root(verify_path: Path) -> Path:
    name = f"verify_{verify_path.parent.as_posix().replace('/', '_')}"
    spec = importlib.util.spec_from_file_location(name, verify_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.default_repo_root()


def risky_pids_under(prefixes: tuple[str, ...]) -> set[int]:
    seen: set[int] = set()
    try:
        out = subprocess.check_output(["ps", "-o", "pid=,args="], text=True, timeout=5)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return seen
    for line in out.splitlines():
        args = line.strip()
        if not args:
            continue
        if not any(marker in args for marker in RISKY_MARKERS):
            continue
        if prefixes and not any(prefix in args for prefix in prefixes):
            continue
        pid_text = args.split(None, 1)[0]
        if pid_text.isdigit():
            seen.add(int(pid_text))
    return seen


class VerifyRepoRootTests(unittest.TestCase):
    def test_default_repo_root_from_foreign_cwd_deep_layout(self):
        with tempfile.TemporaryDirectory(prefix="gre511-root-a-") as tmp:
            base = Path(tmp)
            repo_a = base / "repository_a"
            repo_b = base / "repository_b"
            repo_a.mkdir()
            repo_b.mkdir()
            init_git_repo(repo_a)
            init_git_repo(repo_b)

            known_root = repo_a.resolve()
            helper_dir = known_root / "w" / "x" / "y" / "z" / "helpers"
            helper_dir.mkdir(parents=True)
            verify_copy = helper_dir / "verify.py"
            verify_copy.write_bytes(VERIFY_BYTES)

            prior = risky_pids_under((str(base),))
            previous_cwd = os.getcwd()
            try:
                os.chdir(repo_b)
                discovered = call_default_repo_root(verify_copy).resolve()
            finally:
                os.chdir(previous_cwd)
            after = risky_pids_under((str(base),))

            self.assertEqual(discovered, known_root)
            self.assertEqual(after, prior)

    def test_fixed_parent_depth_misses_git_top_level(self):
        with tempfile.TemporaryDirectory(prefix="gre511-depth-") as tmp:
            base = Path(tmp)
            repo_a = base / "repository_a"
            repo_b = base / "repository_b"
            repo_a.mkdir()
            repo_b.mkdir()
            init_git_repo(repo_a)
            init_git_repo(repo_b)

            known_root = repo_a.resolve()
            helper_dir = known_root / "w" / "x" / "y" / "z" / "helpers"
            helper_dir.mkdir(parents=True)
            verify_copy = helper_dir / "verify.py"
            verify_copy.write_bytes(VERIFY_BYTES)

            fixed_depth_guess = verify_copy.resolve().parents[4]
            self.assertNotEqual(fixed_depth_guess, known_root)

            previous_cwd = os.getcwd()
            try:
                os.chdir(repo_b)
                discovered = call_default_repo_root(verify_copy).resolve()
            finally:
                os.chdir(previous_cwd)

            self.assertEqual(discovered, known_root)

    def test_explicit_repo_invalid_path_exits_before_build(self):
        with tempfile.TemporaryDirectory(prefix="gre511-empty-repo-") as empty:
            proc = subprocess.run(
                [sys.executable, str(HELPER), "--repo", empty],
                capture_output=True,
                text=True,
                timeout=15,
            )
            combined = proc.stdout + proc.stderr
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("rust/ not found", combined)
            self.assertNotIn("BUILD:", combined)


if __name__ == "__main__":
    unittest.main()
