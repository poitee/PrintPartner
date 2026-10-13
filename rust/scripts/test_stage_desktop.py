import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("stage-desktop.py")
COMMIT = "a" * 40
REJECTED = (
    "supply the native pinned Node 24.21.0 ABI 137 runtime "
    "(Linux ELF or macOS Mach-O), not a dispatcher script:"
)
FLEET_DISPATCHER = pathlib.Path("/opt/agent-fleet/bin/node")


def run_stage(node, output, web, env=None):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--web", str(web), "--node", str(node),
         "--output", str(output), "--commit", COMMIT],
        capture_output=True,
        text=True,
        env=env,
    )


class StageNodeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.web = self.root / "web"
        self.web.mkdir()
        self.output = self.root / "stage"
        self.marker = self.root / "invoked"
        self.env = os.environ.copy()
        self.env["PP_STAGE_INVOKED"] = str(self.marker)

    def tearDown(self):
        self.temporary.cleanup()

    def write_dispatcher(self, path):
        path.write_text('#!/bin/sh\n: > "$PP_STAGE_INVOKED"\nexit 0\n')
        path.chmod(0o755)

    def assert_refused(self, result):
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(REJECTED, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(self.marker.exists(), result.stderr)
        self.assertFalse(self.output.exists(), result.stderr)

    def test_shebang_dispatcher_is_refused_before_it_runs(self):
        node = self.root / "node"
        self.write_dispatcher(node)
        self.assert_refused(run_stage(node, self.output, self.web, self.env))

    def test_symlink_to_dispatcher_is_refused_before_it_runs(self):
        node = self.root / "node"
        self.write_dispatcher(node)
        link = self.root / "node-link"
        link.symlink_to(node)
        self.assert_refused(run_stage(link, self.output, self.web, self.env))

    def test_plain_text_node_is_refused_without_a_stage(self):
        node = self.root / "node"
        node.write_text("echo not a binary\n")
        node.chmod(0o755)
        self.assert_refused(run_stage(node, self.output, self.web, self.env))

    def test_empty_node_is_refused_without_a_stage(self):
        node = self.root / "node"
        node.write_bytes(b"")
        node.chmod(0o755)
        self.assert_refused(run_stage(node, self.output, self.web, self.env))

    def test_mach_o_header_is_not_rejected_as_a_dispatcher(self):
        node = self.root / "node"
        node.write_bytes(b"\xcf\xfa\xed\xfe" + b"\x00" * 32)
        node.chmod(0o755)
        result = run_stage(node, self.output, self.web)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("dispatcher script", result.stderr)
        self.assertFalse(self.output.exists(), result.stderr)

    def test_elf_header_is_not_rejected_as_a_dispatcher(self):
        node = self.root / "node"
        node.write_bytes(b"\x7fELF" + b"\x00" * 32)
        node.chmod(0o755)
        result = run_stage(node, self.output, self.web)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("dispatcher script", result.stderr)
        self.assertFalse(self.output.exists(), result.stderr)

    @unittest.skipUnless(FLEET_DISPATCHER.is_file(), "fleet dispatcher absent")
    def test_fleet_dispatcher_is_refused_before_stage_mutation(self):
        result = run_stage(FLEET_DISPATCHER, self.output, self.web, self.env)
        self.assert_refused(result)
        self.assertIn(str(FLEET_DISPATCHER), result.stderr)


if __name__ == "__main__":
    unittest.main()
