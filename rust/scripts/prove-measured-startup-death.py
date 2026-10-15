"""Prove measured Process::spawn startup with a native Node and measured simulator.

The generated package is not a production web bundle. No manifest bypass ships.
Use --negative-control to disarm only the measured spawn guard, require failure,
restore lib.rs byte-for-byte, then require the same test to pass.
"""

import argparse
import hashlib
import json
import os
import platform
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time


REPO = Path(__file__).resolve().parents[2]
TEST = "ticket_t_2::ticket_t_3_drain_measured_release_startup_parent_death"


def negative_cleanup(output):
    matches = re.findall(r"owner=(\d+); node=(\d+); peer=(\d+);", output)
    assert matches, "negative control omitted process identities"
    pids = {pid for cycle in matches for pid in cycle}
    deadline = time.monotonic() + 2
    while True:
        states = {}
        for pid in sorted(pids):
            process_state = subprocess.run(["ps", "-o", "stat=", "-p", pid], text=True, capture_output=True, check=False, timeout=5).stdout
            states[pid] = process_state.strip() or "absent"
        if all(state == "absent" or state[0] in "ZX" for state in states.values()):
            break
        assert time.monotonic() < deadline, f"negative control leaked live processes: {states}"
        time.sleep(0.01)
    return states


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=Path("/tmp/gre448-proof"))
    parser.add_argument("--node", type=Path, default=Path("/usr/bin/node"))
    parser.add_argument("--negative-control", action="store_true")
    args = parser.parse_args()
    node = args.node.resolve(strict=True)
    with node.open("rb") as binary:
        if binary.read(4) not in (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe"):
            parser.error("--node must resolve to a native ELF or Mach-O executable")
    node_identity = json.loads(subprocess.check_output([str(node), "-p",
        "JSON.stringify({version:process.version,abi:process.versions.modules,os:process.platform,arch:process.arch})"], text=True))
    if node_identity["version"] != "v24.21.0" or node_identity["abi"] != "137":
        parser.error("Node 24.21.0 ABI 137 is required")
    host_arch = {"x86_64": "x64", "AMD64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    if sys.platform not in ("linux", "darwin") or node_identity["os"] != sys.platform or not host_arch or node_identity["arch"] != host_arch:
        parser.error("Proof requires the host-native Node runtime OS and architecture")
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "node-identity.json").write_text(json.dumps(node_identity, indent=2) + "\n")
    stage = Path(tempfile.mkdtemp(prefix="measured-simulator-", dir=evidence))
    web = stage / "web"
    shutil.copy2(node, stage / "node")

    def write(relative, contents):
        path = web / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)

    for relative in ("package.json", "apps/server/package.json", "packages/contracts/package.json", "packages/domain/package.json"):
        write(relative, json.dumps({"version": "0.0.0-gre448-simulator", "private": True}))
    write("package-lock.json", '{"lockfileVersion":3}\n')
    write("apps/web/dist/index.html", "<!doctype html><title>GRE-448 measured simulator</title>\n")
    write("apps/web/dist/desktop-build.json", json.dumps({"mode": "desktop", "service_worker": False, "version": "0.0.0-gre448-simulator"}))
    write("packages/contracts/dist/current/index.js", "module.exports = {};\n")
    write("packages/domain/dist/current/index.js", "module.exports = {};\n")
    write("node_modules/gre448-simulator/package.json", '{"name":"gre448-simulator","private":true}\n')
    fixtures = REPO / "rust/crates/pp-compat/tests/fixtures"
    for source, target in (("measured-startup-entry.cjs", "desktop.js"), ("measured-startup-preload.cjs", "desktop-resolution.js")):
        write("apps/server/dist/current/" + target, (fixtures / source).read_text())

    env = dict(os.environ, PP_DESKTOP_RELEASE_MANIFEST=str(stage / "bundle-manifest.json"), PP_COMPAT_MEASURED_STARTUP_STAGE=str(stage))
    (evidence / "environment.json").write_text(json.dumps({name: env[name] for name in ("PP_DESKTOP_RELEASE_MANIFEST", "PP_COMPAT_MEASURED_STARTUP_STAGE")}, indent=2) + "\n")

    def run(label, command, timeout=600):
        with (evidence / "commands.log").open("a") as log:
            log.write(f"{label}: {shlex.join(command)}\n")
        print(f"{label}: {shlex.join(command)}", flush=True)
        with (evidence / (label + ".log")).open("w") as log:
            result = subprocess.run(command, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        print(f"{label}: exit={result.returncode}; log={evidence / (label + '.log')}", flush=True)
        if TEST in command and result.returncode == 0:
            output = (evidence / (label + ".log")).read_text()
            assert "test result: ok. 1 passed; 0 failed" in output, "acceptance test did not run"
            assert "cycle=0; spawns=1; Node and peer dead" in output
            assert "cycle=1; spawns=1; Node and peer dead" in output
        return result.returncode

    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    manifest_command = [sys.executable, str(REPO / "rust/scripts/build-desktop-manifest.py"), "--web", str(web), "--node", str(stage / "node"), "--package-root", str(stage), "--output", env["PP_DESKTOP_RELEASE_MANIFEST"], "--commit", commit]
    if run("manifest", manifest_command) != 0:
        sys.exit("manifest generation failed")
    command = ["cargo", "test", "--locked", "--manifest-path", "rust/Cargo.toml", "-p", "pp-compat", "--lib", TEST, "--", "--exact", "--nocapture"]
    if run("baseline", command) != 0:
        sys.exit("baseline measured startup test failed")
    if args.negative_control:
        source = REPO / "rust/crates/pp-compat/src/lib.rs"
        original = source.read_bytes()
        measured, shell = original.split(b"    async fn spawn_shell(", 1)
        before = b"let (parent_read, parent_death) ="
        assert measured.count(before) == 1
        measured = measured.replace(before, b"let (parent_read, mut parent_death) =", 1)
        before = b"        drop(parent_read);\n"
        assert measured.count(before) == 1
        measured = measured.replace(before, before + b"        parent_death.release();\n", 1)
        try:
            source.write_bytes(measured + b"    async fn spawn_shell(" + shell)
            status = run("negative", command)
        finally:
            source.write_bytes(original)
        assert source.read_bytes() == original, "production source restoration failed"
        (evidence / "restored-lib-sha256.txt").write_text(hashlib.sha256(original).hexdigest() + "\n")
        negative = (evidence / "negative.log").read_text()
        assert status != 0 and "startup group outlived force-killed owner" in negative, "negative control did not fail the intended invariant"
        assert "test result: FAILED. 0 passed; 1 failed" in negative, "negative control ran no acceptance test"
        states = negative_cleanup(negative)
        (evidence / "negative-cleanup.json").write_text(json.dumps(states, indent=2) + "\n")
        if run("restored", command) != 0:
            sys.exit("restored measured startup test failed")
    print(f"Measured simulator proof passed. Assets and logs retained at {evidence}")


if __name__ == "__main__":
    main()
