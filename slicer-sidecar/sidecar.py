#!/usr/bin/env python3
"""
Slicer sidecar HTTP service.

Wraps a slicer CLI (OrcaSlicer / PrusaSlicer / BambuStudio) headless mode and
exposes an HTTP API matching the contract expected by Print Partner's
slicer-sidecar adapter (web/apps/server/src/integrations/adapters/slicer-sidecar.ts):

  GET  /health        -> 200 {"status": "ok"}
  POST /slice         -> multipart/form-data:
                            model             (required) - 3mf or stl file bytes
                            machine_config    (optional) - JSON object, printer/machine settings
                            process_config    (optional) - JSON object, print process settings
                            filament_configs  (optional) - JSON array of filament setting objects
                          Response: application/json
                            {"gcode": "<base64>", "thumbnail": "<base64>", "filename": "plate_1.gcode"}

Which CLI binary to invoke is controlled by the SLICER_KIND env var
("orca" | "prusa" | "bambu") and SLICER_BIN (path to the CLI executable).
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from flask import Flask, request, jsonify

app = Flask(__name__)

SLICER_KIND = os.environ.get("SLICER_KIND", "orca")
SLICER_BIN = os.environ.get("SLICER_BIN", "/opt/orcaslicer/bin/orca-slicer")
WORKDIR_ROOT = os.environ.get("SIDECAR_WORKDIR", "/tmp/sidecar-jobs")
SLICE_TIMEOUT_S = int(os.environ.get("SLICE_TIMEOUT_S", "240"))

Path(WORKDIR_ROOT).mkdir(parents=True, exist_ok=True)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "slicer": SLICER_KIND, "bin": SLICER_BIN, "exists": os.path.exists(SLICER_BIN)})


def _write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


@app.post("/slice")
def slice_endpoint():
    if "model" not in request.files:
        return jsonify({"error": "missing 'model' file field"}), 400

    model_file = request.files["model"]
    job_id = uuid.uuid4().hex[:12]
    job_dir = Path(WORKDIR_ROOT) / job_id
    out_dir = job_dir / "out"
    job_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        # Determine model extension from filename (default 3mf).
        orig_name = model_file.filename or "plate.3mf"
        ext = ".3mf" if orig_name.lower().endswith(".3mf") else ".stl" if orig_name.lower().endswith(".stl") else ".3mf"
        model_path = job_dir / f"model{ext}"
        model_file.save(str(model_path))

        settings_paths = []
        machine_config_raw = request.form.get("machine_config")
        process_config_raw = request.form.get("process_config")
        filament_configs_raw = request.form.get("filament_configs")

        if machine_config_raw:
            machine_path = job_dir / "machine.json"
            _write_json(machine_path, json.loads(machine_config_raw))
            settings_paths.append(str(machine_path))
        if process_config_raw:
            process_path = job_dir / "process.json"
            _write_json(process_path, json.loads(process_config_raw))
            settings_paths.append(str(process_path))

        filament_paths = []
        if filament_configs_raw:
            filament_list = json.loads(filament_configs_raw)
            for i, fc in enumerate(filament_list):
                fpath = job_dir / f"filament_{i}.json"
                _write_json(fpath, fc)
                filament_paths.append(str(fpath))

        cmd = [SLICER_BIN, "--slice", "0", "--outputdir", str(out_dir)]
        if settings_paths:
            cmd += ["--load-settings", ";".join(settings_paths)]
        if filament_paths:
            cmd += ["--load-filaments", ";".join(filament_paths)]
        cmd.append(str(model_path))

        env = dict(os.environ)
        env.pop("DISPLAY", None)  # headless CLI slicing does not need X

        start = time.time()
        proc = subprocess.run(
            cmd,
            cwd=str(job_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=SLICE_TIMEOUT_S,
        )
        elapsed = time.time() - start

        gcode_files = sorted(out_dir.glob("*.gcode")) + sorted(out_dir.glob("*.bgcode"))
        result_json_path = out_dir / "result.json"
        result_meta = {}
        if result_json_path.exists():
            try:
                result_meta = json.loads(result_json_path.read_text())
            except Exception:
                pass

        if not gcode_files:
            return (
                jsonify(
                    {
                        "error": "slicing produced no gcode",
                        "return_code": proc.returncode,
                        "stdout_tail": proc.stdout[-2000:],
                        "stderr_tail": proc.stderr[-2000:],
                        "slicer_result": result_meta,
                        "elapsed_s": elapsed,
                    }
                ),
                502,
            )

        gcode_path = gcode_files[0]
        gcode_bytes = gcode_path.read_bytes()

        # Thumbnails: OrcaSlicer CLI does not export a separate PNG by default;
        # leave empty (adapter tolerates empty thumbnail).
        thumbnail_bytes = b""

        return jsonify(
            {
                "gcode": base64.b64encode(gcode_bytes).decode("ascii"),
                "thumbnail": base64.b64encode(thumbnail_bytes).decode("ascii"),
                "filename": gcode_path.name,
                "elapsed_s": elapsed,
            }
        )
    except subprocess.TimeoutExpired:
        return jsonify({"error": f"slicing timed out after {SLICE_TIMEOUT_S}s"}), 504
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "2814"))
    threads = int(os.environ.get("WAITRESS_THREADS", "8"))
    # Prefer Waitress over Flask's built-in server: it is a production WSGI
    # server with a proper thread pool, so /health stays responsive while a
    # plate is mid-slice and Node undici keep-alive clients do not hit a
    # half-closed werkzeug socket.
    try:
        from waitress import serve

        serve(app, host="0.0.0.0", port=port, threads=threads, channel_timeout=SLICE_TIMEOUT_S + 60)
    except ImportError:
        app.run(host="0.0.0.0", port=port, threaded=True)
