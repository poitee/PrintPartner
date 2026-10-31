import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("check-large-files.py")
SPEC = importlib.util.spec_from_file_location("check_large_files", SCRIPT)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class LargeFileTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def stage(self, name, size):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x" * size)
        subprocess.run(["git", "-C", str(self.root), "add", "--", name], check=True)

    def test_files_at_the_limit_pass(self):
        self.stage("small.txt", 10)
        self.stage("dir/edge name.bin", 100)
        self.assertEqual(CHECK.oversized(self.root, 100), [])

    def test_staged_file_over_the_limit_fails(self):
        self.stage("ok.txt", 5)
        self.stage("fixtures/big.json", 101)
        self.assertEqual(CHECK.oversized(self.root, 100), [("fixtures/big.json", 101)])

    def test_staged_content_is_checked_not_the_working_tree(self):
        self.stage("data.bin", 101)
        (self.root / "data.bin").write_bytes(b"x")
        self.assertEqual(CHECK.oversized(self.root, 100), [("data.bin", 101)])

    def test_empty_index_passes(self):
        self.assertEqual(CHECK.oversized(self.root, 100), [])

    def test_repository_is_within_the_default_limit(self):
        self.assertEqual(CHECK.main(), 0)


if __name__ == "__main__":
    unittest.main()
