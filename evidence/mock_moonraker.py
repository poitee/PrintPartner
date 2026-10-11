# Local loopback-only mock Moonraker for PR #200 evidence. Never contacts real printers.
import json, sys, time, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit

PORT = int(sys.argv[1])
LOG = sys.argv[2]
START = time.monotonic()
lock = threading.Lock()
polls = {"query": 0, "other": 0}

def phase():
    # Cycle printing -> complete -> idle every 20s so each poll observes changing state.
    stage = int((time.monotonic() - START) // 20) % 3
    return stage

def state_body():
    s = phase()
    if s == 0:
        st = {"print_stats": {"state": "printing", "filename": "bracket.gcode"},
              "virtual_sdcard": {"progress": 0.425},
              "extruder": {"temperature": 210.2, "target": 215},
              "heater_bed": {"temperature": 59.8, "target": 60}}
    elif s == 1:
        st = {"print_stats": {"state": "complete", "filename": "bracket.gcode"},
              "virtual_sdcard": {"progress": 1.0},
              "extruder": {"temperature": 45.0, "target": 0},
              "heater_bed": {"temperature": 35.0, "target": 0}}
    else:
        st = {"print_stats": {"state": "standby", "filename": ""},
              "virtual_sdcard": {"progress": 0.0},
              "extruder": {"temperature": 25.0, "target": 0},
              "heater_bed": {"temperature": 24.0, "target": 0}}
    return {"result": {"eventtime": round(time.monotonic() - START, 1), "status": st}}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
    def do_GET(self):
        path = urlsplit(self.path).path
        with lock:
            with open(LOG, "a") as f:
                f.write(f"{time.strftime('%H:%M:%S')} GET {self.path}\n")
        if path == "/printer/objects/query":
            with lock: polls["query"] += 1
            return self._send(200, state_body())
        if path == "/server/info":
            return self._send(200, {"result": {"klippy_state": "ready", "moonraker_version": "mock"}})
        if path == "/printer/info":
            return self._send(200, {"result": {"state": "ready", "hostname": "mock-printer"}})
        with lock: polls["other"] += 1
        return self._send(404, {"error": "not found"})

ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
