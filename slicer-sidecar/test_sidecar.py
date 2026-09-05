import base64
from io import BytesIO
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sidecar


class SidecarTest(unittest.TestCase):
    @staticmethod
    def _write_slicer(path: Path, body: str) -> None:
        path.write_text(f"#!/bin/sh\n{body}", encoding="utf-8")
        path.chmod(
            stat.S_IRUSR
            | stat.S_IWUSR
            | stat.S_IXUSR
            | stat.S_IRGRP
            | stat.S_IXGRP
        )

    @staticmethod
    def _post_model():
        with sidecar.app.test_client() as client:
            return client.post(
                "/slice",
                data={"model": (BytesIO(b"fake 3mf"), "plate.3mf")},
                content_type="multipart/form-data",
            )

    def test_slice_rejects_partial_gcode_when_slicer_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake_slicer = root / "fake-slicer"
            self._write_slicer(
                fake_slicer,
                "out=\"\"\n"
                "while [ \"$#\" -gt 0 ]; do\n"
                "  if [ \"$1\" = \"--outputdir\" ]; then out=\"$2\"; shift 2; else shift; fi\n"
                "done\n"
                "printf 'partial gcode\\n' > \"$out/partial.gcode\"\n"
                "printf 'slicer failed\\n' >&2\n"
                "exit 7\n",
            )
            old_bin = sidecar.SLICER_BIN
            old_workdir = sidecar.WORKDIR_ROOT
            sidecar.SLICER_BIN = str(fake_slicer)
            sidecar.WORKDIR_ROOT = str(root / "jobs")
            try:
                response = self._post_model()
                self.assertEqual(response.status_code, 502)
                self.assertEqual(response.json["return_code"], 7)
            finally:
                sidecar.SLICER_BIN = old_bin
                sidecar.WORKDIR_ROOT = old_workdir

    def test_slice_returns_gcode_when_slicer_succeeds(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake_slicer = root / "fake-slicer"
            self._write_slicer(
                fake_slicer,
                "out=\"\"\n"
                "while [ \"$#\" -gt 0 ]; do\n"
                "  if [ \"$1\" = \"--outputdir\" ]; then out=\"$2\"; shift 2; else shift; fi\n"
                "done\n"
                "printf 'complete gcode\\n' > \"$out/plate.gcode\"\n",
            )
            old_bin = sidecar.SLICER_BIN
            old_workdir = sidecar.WORKDIR_ROOT
            sidecar.SLICER_BIN = str(fake_slicer)
            sidecar.WORKDIR_ROOT = str(root / "jobs")
            try:
                response = self._post_model()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(base64.b64decode(response.json["gcode"]), b"complete gcode\n")
                self.assertEqual(response.json["filename"], "plate.gcode")
            finally:
                sidecar.SLICER_BIN = old_bin
                sidecar.WORKDIR_ROOT = old_workdir

    def test_slice_rejects_malformed_machine_config_as_client_input(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            old_workdir = sidecar.WORKDIR_ROOT
            sidecar.WORKDIR_ROOT = str(Path(temp_dir) / "jobs")
            try:
                with sidecar.app.test_client() as client:
                    response = client.post(
                        "/slice",
                        data={
                            "model": (BytesIO(b"fake 3mf"), "plate.3mf"),
                            "machine_config": "{not-json",
                        },
                        content_type="multipart/form-data",
                    )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json,
                    {"error": "machine_config must be a JSON object"},
                )
            finally:
                sidecar.WORKDIR_ROOT = old_workdir

    def test_slice_does_not_disclose_operational_exception_text(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            old_workdir = sidecar.WORKDIR_ROOT
            sidecar.WORKDIR_ROOT = str(Path(temp_dir) / "jobs")
            try:
                with patch.object(
                    sidecar.subprocess,
                    "run",
                    side_effect=OSError("private path /srv/customer/secrets"),
                ):
                    response = self._post_model()
                self.assertEqual(response.status_code, 500)
                self.assertEqual(response.json, {"error": "slicing failed"})
                self.assertNotIn("private path", response.get_data(as_text=True))
            finally:
                sidecar.WORKDIR_ROOT = old_workdir

    def test_health_is_unhealthy_when_slicer_binary_is_missing(self):
        old_bin = sidecar.SLICER_BIN
        sidecar.SLICER_BIN = "/definitely/missing/slicer"
        try:
            with sidecar.app.test_client() as client:
                response = client.get("/health")
            self.assertEqual(response.status_code, 503)
            self.assertFalse(response.json["exists"])
            self.assertFalse(response.json["executable"])
        finally:
            sidecar.SLICER_BIN = old_bin

    def test_health_is_healthy_when_slicer_binary_is_executable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_slicer = Path(temp_dir) / "fake-slicer"
            self._write_slicer(fake_slicer, "exit 0\n")
            old_bin = sidecar.SLICER_BIN
            sidecar.SLICER_BIN = str(fake_slicer)
            try:
                with sidecar.app.test_client() as client:
                    response = client.get("/health")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json["status"], "ok")
                self.assertTrue(response.json["exists"])
                self.assertTrue(response.json["executable"])
            finally:
                sidecar.SLICER_BIN = old_bin

    def test_health_is_unhealthy_when_slicer_path_is_not_executable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_slicer = Path(temp_dir) / "fake-slicer"
            fake_slicer.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            old_bin = sidecar.SLICER_BIN
            sidecar.SLICER_BIN = str(fake_slicer)
            try:
                with sidecar.app.test_client() as client:
                    response = client.get("/health")
                self.assertEqual(response.status_code, 503)
                self.assertTrue(response.json["exists"])
                self.assertFalse(response.json["executable"])
            finally:
                sidecar.SLICER_BIN = old_bin

    def test_health_is_unhealthy_when_slicer_path_is_a_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            old_bin = sidecar.SLICER_BIN
            sidecar.SLICER_BIN = temp_dir
            try:
                with sidecar.app.test_client() as client:
                    response = client.get("/health")
                self.assertEqual(response.status_code, 503)
                self.assertTrue(response.json["exists"])
                self.assertFalse(response.json["executable"])
            finally:
                sidecar.SLICER_BIN = old_bin


if __name__ == "__main__":
    unittest.main()
