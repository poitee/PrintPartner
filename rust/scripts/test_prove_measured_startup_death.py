import ast
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("prove-measured-startup-death.py")
spec = importlib.util.spec_from_file_location("startup_proof", SCRIPT)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
TWO_CYCLES = """cycle=0; owner=101; node=102; peer=103;
cycle=1; owner=201; node=202; peer=203;
startup group outlived force-killed owner
"""


class CleanupTests(unittest.TestCase):
    def test_checks_both_cycles(self):
        with patch.object(proof.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="")) as ps:
            self.assertEqual(proof.negative_cleanup(TWO_CYCLES), {
                "101": "absent", "102": "absent", "103": "absent",
                "201": "absent", "202": "absent", "203": "absent",
            })
        self.assertEqual([call.args[0][-1] for call in ps.call_args_list],
                         ["101", "102", "103", "201", "202", "203"])

    def test_rejects_live_process_in_second_cycle(self):
        for role in range(3):
            with self.subTest(role=role):
                pids = ["999999994", "999999995", "999999996"]
                pids[role] = str(os.getpid())
                output = ("cycle=0; owner=999999991; node=999999992; peer=999999993;\n"
                          f"cycle=1; owner={pids[0]}; node={pids[1]}; peer={pids[2]};\n")
                with patch.object(proof.time, "monotonic", side_effect=[0, 3]):
                    with self.assertRaisesRegex(AssertionError, "negative control leaked live processes"):
                        proof.negative_cleanup(output)


class RuntimeTests(unittest.TestCase):
    def test_rejects_wrong_native_identity_before_creating_evidence(self):
        node = Path(sys.executable).resolve(strict=True)
        valid = {"version": "v24.21.0", "abi": "137", "os": "linux", "arch": "x64"}
        for key, value in (("version", "v22.20.0"), ("abi", "127"), ("os", "darwin"), ("arch", "arm64")):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                evidence = Path(directory) / "evidence"
                error = io.StringIO()
                with patch.object(sys, "argv", [str(SCRIPT), "--node", str(node), "--evidence", str(evidence)]), \
                     patch.object(proof.sys, "platform", "linux"), \
                     patch.object(proof.platform, "machine", return_value="x86_64"), \
                     patch.object(proof.subprocess, "check_output", return_value=json.dumps(valid | {key: value})) as identity, \
                     patch.object(proof.tempfile, "mkdtemp") as stage, contextlib.redirect_stderr(error):
                    with self.assertRaises(SystemExit) as result:
                        proof.main()
                self.assertEqual(result.exception.code, 2)
                self.assertIn("Node 24.21.0 ABI 137 is required" if key in ("version", "abi") else "host-native Node runtime", error.getvalue())
                identity.assert_called_once()
                self.assertEqual(identity.call_args.args[0][0], str(node))
                stage.assert_not_called()
                self.assertFalse(evidence.exists())

    def test_stager_native_headers_reach_identity_validation(self):
        stager = ast.parse(SCRIPT.with_name("stage-desktop.py").read_text())
        headers = next(ast.literal_eval(node.value.args[0]) for node in stager.body
                       if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == "NATIVE_NODE_HEADERS"
                               for target in node.targets))
        self.assertEqual(proof.NATIVE_NODE_HEADERS, headers)
        for header in sorted(headers):
            with self.subTest(header=header), tempfile.TemporaryDirectory() as directory:
                node = Path(directory) / "node"
                node.write_bytes(header)
                node.chmod(0o755)
                evidence = Path(directory) / "evidence"
                with patch.object(sys, "argv", [str(SCRIPT), "--node", str(node), "--evidence", str(evidence)]), \
                     patch.object(proof.subprocess, "check_output", side_effect=RuntimeError("identity reached")) as identity:
                    with self.assertRaisesRegex(RuntimeError, "identity reached"):
                        proof.main()
                identity.assert_called_once()
                self.assertEqual(identity.call_args.args[0][0], str(node.resolve()))
                self.assertFalse(evidence.exists())

    def test_rejects_dispatcher_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            node = Path(directory) / "node"
            node.write_text("#!/bin/sh\nexit 0\n")
            node.chmod(0o755)
            evidence = Path(directory) / "evidence"
            with patch.object(sys, "argv", [str(SCRIPT), "--node", str(node), "--evidence", str(evidence)]), \
                 patch.object(proof.subprocess, "check_output") as identity, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as result:
                    proof.main()
            self.assertEqual(result.exception.code, 2)
            identity.assert_not_called()
            self.assertFalse(evidence.exists())


if __name__ == "__main__":
    unittest.main()
