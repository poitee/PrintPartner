from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.parse import urlparse


SCRIPT = Path(__file__).with_name("workflow-smoke.sh")
RELEASE_WORKFLOW = Path(__file__).parents[2] / ".github" / "workflows" / "release.yml"


class SmokeHandler(BaseHTTPRequestHandler):
    parts = 1
    exports = 1
    asset_status = 200

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _send(self, body: object | str, status: int = 200) -> None:
        encoded = (
            body.encode()
            if isinstance(body, str)
            else json.dumps(body, separators=(",", ":")).encode()
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._send({"ok": True})
        elif path == "/jobs/recompute-job":
            self._send({"status": "done", "result": {"part_count": self.parts}})
        elif path == "/jobs/export-job":
            self._send({"status": "done", "result": {"file_total": self.exports}})
        elif path == "/plans/1/parts":
            parts = [{"id": 1, "filename": "cube.stl"}] if self.parts else []
            self._send({"total": len(parts), "parts": parts})
        elif path == "/plans/1/checkoff":
            self._send({"parts": []})
        elif path == "/":
            self._send('<script src="/assets/app.js"></script>')
        elif path == "/assets/app.js":
            self._send("asset", self.asset_status)
        else:
            self._send({"detail": "not found"}, 404)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/sources":
            self._send({"id": 1})
        elif path == "/sources/1/upload-files":
            self._send({"id": 1, "stl_count": 1})
        elif path == "/plans":
            self._send({"id": 1})
        elif path == "/jobs/recompute":
            self._send({"job_id": "recompute-job"})
        elif path == "/jobs/export-stl-pack":
            self._send({"job_id": "export-job"})
        else:
            self._send({"detail": "not found"}, 404)

    def do_PUT(self) -> None:
        self._send({"profile_id": 1})

    def do_PATCH(self) -> None:
        self._send({"part_id": 1, "printed_count": 1})


class WorkflowSmokeTests(unittest.TestCase):
    def run_smoke(self, *, parts: int = 1, exports: int = 1, asset_status: int = 200):
        handler = type(
            "ScenarioHandler",
            (SmokeHandler,),
            {"parts": parts, "exports": exports, "asset_status": asset_status},
        )
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory:
                fixture = Path(directory) / "cube.stl"
                fixture.write_text("solid cube\nendsolid cube\n")
                env = {
                    **os.environ,
                    "BASE": f"http://127.0.0.1:{server.server_port}",
                    "SOURCE_KIND": "local",
                    "SOURCE_URL": directory,
                    "SOURCE_UPLOAD_FILE": str(fixture),
                }
                return subprocess.run(
                    ["bash", str(SCRIPT)],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_accepts_nonempty_workflow(self) -> None:
        result = self.run_smoke()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_rejects_zero_parts(self) -> None:
        result = self.run_smoke(parts=0)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_rejects_zero_exports(self) -> None:
        result = self.run_smoke(exports=0)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_rejects_non_success_asset_response(self) -> None:
        result = self.run_smoke(asset_status=500)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)


class ReleaseWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = RELEASE_WORKFLOW.read_text()

    def test_peels_annotated_tag_before_any_image_publish(self) -> None:
        peel = self.workflow.index('git rev-parse "refs/tags/${TAG}^{}"')
        publish = self.workflow.index("Build and push candidate image")
        self.assertIn("fetch-depth: 0", self.workflow)
        self.assertLess(peel, publish)

    def test_does_not_mutate_package_visibility(self) -> None:
        self.assertNotIn("visibility", self.workflow.lower())
        self.assertNotIn("/packages/container/", self.workflow)

    def test_release_precedes_create_or_verify_version_alias(self) -> None:
        release = self.workflow.index("Create or verify GitHub Release")
        version_alias = self.workflow.index("Create or verify immutable version alias")
        latest = self.workflow.index("Advance latest convenience alias")
        self.assertLess(release, version_alias)
        self.assertLess(version_alias, latest)
        self.assertIn('test "$existing" = "$DIGEST"', self.workflow)
        self.assertIn("group: release-publication", self.workflow)
        self.assertIn('latest_release="$(gh release view', self.workflow)

    def test_attaches_and_verifies_release_identity_asset(self) -> None:
        self.assertIn("render-asset", self.workflow)
        self.assertIn("release-identity.json", self.workflow)
        self.assertIn("cmp --silent", self.workflow)

    def test_verifies_index_and_platform_descriptor_annotations(self) -> None:
        self.assertIn("index:org.opencontainers.image.revision", self.workflow)
        self.assertIn(
            "manifest-descriptor:org.opencontainers.image.revision", self.workflow
        )
        self.assertIn("all(.manifests[] | select(", self.workflow)
        self.assertIn(".platform.architecture == \"arm64\"", self.workflow)


if __name__ == "__main__":
    unittest.main()
