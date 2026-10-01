#!/usr/bin/env python3
"""
Slicer sidecar HTTP service.

Wraps a slicer CLI (OrcaSlicer / PrusaSlicer / BambuStudio) headless mode and
exposes an HTTP API matching the contract expected by Print Partner's
slicer-sidecar adapter (web/apps/server/src/integrations/adapters/slicer-sidecar.ts):

  GET  /health        -> 200 when the slicer binary is executable;
                        503 otherwise
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
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from flask import Flask, request, jsonify

app = Flask(__name__)

SLICER_KIND = os.environ.get("SLICER_KIND", "orca")
SLICER_BIN = os.environ.get("SLICER_BIN", "/opt/orcaslicer/bin/orca-slicer")
WORKDIR_ROOT = os.environ.get("SIDECAR_WORKDIR", "/tmp/sidecar-jobs")
SLICE_TIMEOUT_S = int(os.environ.get("SLICE_TIMEOUT_S", "240"))
SHUTDOWN_GRACE_S = 1
SHUTDOWN_TIMEOUT_S = 4

Path(WORKDIR_ROOT).mkdir(parents=True, exist_ok=True)


class ServiceStopping(Exception):
    pass


@dataclass
class SliceJob:
    process: subprocess.Popen | None = None
    process_cleaned: bool = False


def _signal_group(proc, signum):
    try:
        os.killpg(proc.pid, signum)
    except ProcessLookupError:
        pass


class SliceJobs:
    def __init__(self):
        self.stopped_at = None
        self.condition = threading.Condition()
        self.active = {}

    def request_stop(self, signum=None, frame=None):
        if self.stopped_at is None:
            self.stopped_at = time.monotonic()

    def admit(self, job_dir):
        with self.condition:
            if self.stopped_at is not None:
                raise ServiceStopping
            self.active[job_dir] = SliceJob()

    def start(self, job_dir, cmd, env):
        with self.condition:
            if self.stopped_at is not None:
                raise ServiceStopping
            proc = subprocess.Popen(
                cmd,
                cwd=str(job_dir),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            job = self.active[job_dir]
            job.process = proc
            return job

    def finish(self, job_dir):
        with self.condition:
            job = self.active[job_dir]
            if job.process is not None and not job.process_cleaned:
                return
        shutil.rmtree(job_dir, ignore_errors=True)
        with self.condition:
            if not job_dir.exists():
                del self.active[job_dir]
                self.condition.notify_all()

    def signal_all(self, signum):
        with self.condition:
            for job in self.active.values():
                if job.process is not None:
                    _signal_group(job.process, signum)

    def wait_until(self, deadline):
        with self.condition:
            while self.active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self.condition.wait(remaining)
            return True


jobs = SliceJobs()


def _run_slicer(job_dir, cmd, env):
    job = jobs.start(job_dir, cmd, env)
    proc = job.process
    try:
        stdout, stderr = proc.communicate(timeout=SLICE_TIMEOUT_S)
        return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
    finally:
        # A descendant can survive its leader or keep the captured pipes open.
        try:
            _signal_group(proc, signal.SIGKILL)
            deadline = (jobs.stopped_at or time.monotonic()) + SHUTDOWN_TIMEOUT_S
            proc.wait(timeout=max(0, deadline - time.monotonic()))
            while True:
                try:
                    pid, _ = os.waitpid(-proc.pid, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid == 0:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.SubprocessError("Slicer process cleanup exceeded its deadline")
                    time.sleep(min(0.01, remaining))
            job.process_cleaned = True
        finally:
            proc.stdout.close()
            proc.stderr.close()


@app.get("/health")
def health():
    exists = os.path.exists(SLICER_BIN)
    executable = os.path.isfile(SLICER_BIN) and os.access(SLICER_BIN, os.X_OK)
    return (
        jsonify(
            {
                "status": "ok" if executable else "unhealthy",
                "slicer": SLICER_KIND,
                "bin": SLICER_BIN,
                "exists": exists,
                "executable": executable,
            }
        ),
        200 if executable else 503,
    )


def _write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


class InvalidSliceConfig(ValueError):
    pass


def _parse_json_object(raw, field_name):
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise InvalidSliceConfig(f"{field_name} must be a JSON object") from error
    if not isinstance(parsed, dict):
        raise InvalidSliceConfig(f"{field_name} must be a JSON object")
    return parsed


def _parse_filament_configs(raw):
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise InvalidSliceConfig(
            "filament_configs must be a JSON array of objects"
        ) from error
    if not isinstance(parsed, list) or any(not isinstance(item, dict) for item in parsed):
        raise InvalidSliceConfig("filament_configs must be a JSON array of objects")
    return parsed


@app.post("/slice")
def slice_endpoint():
    if jobs.stopped_at is not None:
        return jsonify({"error": "sidecar is stopping"}), 503
    if "model" not in request.files:
        return jsonify({"error": "missing 'model' file field"}), 400

    model_file = request.files["model"]
    try:
        machine_config = _parse_json_object(
            request.form.get("machine_config"), "machine_config"
        )
        process_config = _parse_json_object(
            request.form.get("process_config"), "process_config"
        )
        filament_configs = _parse_filament_configs(
            request.form.get("filament_configs")
        )
    except InvalidSliceConfig as error:
        return jsonify({"error": str(error)}), 400

    job_id = uuid.uuid4().hex[:12]
    job_dir = Path(WORKDIR_ROOT) / job_id
    out_dir = job_dir / "out"
    try:
        jobs.admit(job_dir)
    except ServiceStopping:
        return jsonify({"error": "sidecar is stopping"}), 503

    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        out_dir.mkdir(parents=True, exist_ok=True)
        # Determine model extension from filename (default 3mf).
        orig_name = model_file.filename or "plate.3mf"
        ext = ".3mf" if orig_name.lower().endswith(".3mf") else ".stl" if orig_name.lower().endswith(".stl") else ".3mf"
        model_path = job_dir / f"model{ext}"
        model_file.save(str(model_path))

        settings_paths = []
        if machine_config is not None:
            machine_path = job_dir / "machine.json"
            _write_json(machine_path, machine_config)
            settings_paths.append(str(machine_path))
        if process_config is not None:
            process_path = job_dir / "process.json"
            _write_json(process_path, process_config)
            settings_paths.append(str(process_path))

        filament_paths = []
        for i, filament_config in enumerate(filament_configs):
            fpath = job_dir / f"filament_{i}.json"
            _write_json(fpath, filament_config)
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
        proc = _run_slicer(job_dir, cmd, env)
        elapsed = time.time() - start

        if proc.returncode != 0:
            return (
                jsonify(
                    {
                        "error": "slicer exited with a non-zero status",
                        "return_code": proc.returncode,
                        "stdout_tail": proc.stdout[-2000:],
                        "stderr_tail": proc.stderr[-2000:],
                        "elapsed_s": elapsed,
                    }
                ),
                502,
            )

        gcode_files = sorted(out_dir.glob("*.gcode")) + sorted(out_dir.glob("*.bgcode"))
        result_json_path = out_dir / "result.json"
        result_meta = {}
        if result_json_path.exists():
            try:
                parsed_result_meta = json.loads(result_json_path.read_text())
                if isinstance(parsed_result_meta, dict):
                    result_meta = parsed_result_meta
            except (OSError, UnicodeError, json.JSONDecodeError):
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
    except ServiceStopping:
        return jsonify({"error": "sidecar is stopping"}), 503
    except subprocess.TimeoutExpired:
        return jsonify({"error": f"slicing timed out after {SLICE_TIMEOUT_S}s"}), 504
    except (OSError, subprocess.SubprocessError):
        app.logger.exception("Slicing operation failed")
        return jsonify({"error": "slicing failed"}), 500
    finally:
        jobs.finish(job_dir)


def run_server():
    from waitress import create_server, wasyncore

    signal.signal(signal.SIGTERM, jobs.request_stop)
    signal.signal(signal.SIGINT, jobs.request_stop)
    if jobs.stopped_at is not None:
        return 0
    port = int(os.environ.get("PORT", "2814"))
    threads = int(os.environ.get("WAITRESS_THREADS", "8"))
    socket_map = {}
    server = create_server(
        app,
        map=socket_map,
        host="0.0.0.0",
        port=port,
        threads=threads,
        channel_timeout=SLICE_TIMEOUT_S + 60,
        asyncore_loop_timeout=0.1,
    )
    io_failed = False

    def run_io():
        nonlocal io_failed
        try:
            server.run()
        except Exception:
            io_failed = True
            app.logger.exception("Waitress failed")

    io_thread = threading.Thread(target=run_io, name="waitress-io", daemon=True)
    io_thread.start()
    exit_code = 0
    while jobs.stopped_at is None:
        io_thread.join(0.05)
        if not io_thread.is_alive():
            app.logger.error("Waitress stopped unexpectedly")
            exit_code = 1
            jobs.request_stop()

    deadline = jobs.stopped_at + SHUTDOWN_TIMEOUT_S
    try:
        jobs.signal_all(signal.SIGTERM)
        if not jobs.wait_until(min(jobs.stopped_at + SHUTDOWN_GRACE_S, deadline)):
            jobs.signal_all(signal.SIGKILL)
        if not jobs.wait_until(deadline):
            app.logger.error("Sidecar job cleanup exceeded the shutdown deadline")
            exit_code = 1
    except OSError:
        app.logger.exception("Sidecar shutdown failed")
        exit_code = 1
    finally:
        server.task_dispatcher.shutdown(timeout=max(0, deadline - time.monotonic()))
        wasyncore.close_all(socket_map)
        io_thread.join(max(0, deadline - time.monotonic()))
    if io_failed or server.task_dispatcher.threads or io_thread.is_alive() or time.monotonic() >= deadline:
        app.logger.error("Waitress shutdown exceeded the shutdown deadline")
        exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(run_server())
