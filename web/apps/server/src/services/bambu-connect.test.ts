import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  bambuConnectDisplayName,
  bambuConnectLaunchCommand,
  buildBambuConnectUrl,
  isAllowedBambuConnectFilename,
  resolveBambuConnectHostPath,
  sanitizeBambuConnectFilename,
} from "./bambu-connect.js";

describe("bambu-connect", () => {
  it("accepts Bambu Connect file types", () => {
    expect(isAllowedBambuConnectFilename("plate.gcode.3mf")).toBe(true);
    expect(isAllowedBambuConnectFilename("plate.3mf")).toBe(true);
    expect(isAllowedBambuConnectFilename("job.gcode")).toBe(true);
    expect(isAllowedBambuConnectFilename("job.bgcode")).toBe(false);
  });

  it("sanitizes path segments out of filenames", () => {
    expect(sanitizeBambuConnectFilename("../../x.3mf")).toBe("x.3mf");
    expect(bambuConnectDisplayName("Cube.gcode.3mf")).toBe("Cube");
  });

  it("builds the official import-file URL scheme", () => {
    const url = buildBambuConnectUrl("/tmp/cube.gcode.3mf", "Cube");
    expect(url.startsWith("bambu-connect://import-file?")).toBe(true);
    const qs = new URL(url.replace("bambu-connect://", "https://x/")).searchParams;
    expect(qs.get("path")).toBe("/tmp/cube.gcode.3mf");
    expect(qs.get("name")).toBe("Cube");
    expect(qs.get("version")).toBe("1.0.0");
  });

  it("maps container paths when BAMBU_CONNECT_HOST_PATH_MAP is set", () => {
    const prev = process.env.BAMBU_CONNECT_HOST_PATH_MAP;
    process.env.BAMBU_CONNECT_HOST_PATH_MAP = "/data=/Users/me/pp-data";
    try {
      expect(resolveBambuConnectHostPath("/data/exports/a.3mf")).toBe(
        "/Users/me/pp-data/exports/a.3mf",
      );
      expect(resolveBambuConnectHostPath("/data")).toBe("/Users/me/pp-data");
      expect(resolveBambuConnectHostPath("/database/a.3mf")).toBe("/database/a.3mf");
      expect(resolveBambuConnectHostPath("/other/a.3mf")).toBe("/other/a.3mf");
    } finally {
      if (prev == null) delete process.env.BAMBU_CONNECT_HOST_PATH_MAP;
      else process.env.BAMBU_CONNECT_HOST_PATH_MAP = prev;
    }
  });

  it("strips control characters from filenames", () => {
    expect(sanitizeBambuConnectFilename("bad\nname.3mf")).toBe("badname.3mf");
  });

  it("preserves URL query ampersands on Windows launch", () => {
    const url = buildBambuConnectUrl("/tmp/cube.gcode.3mf", "Cube");
    expect(url).toContain("&");
    const { cmd, args } = bambuConnectLaunchCommand(url, "win32");
    expect(cmd).toBe("rundll32");
    expect(args).toEqual(["url.dll,FileProtocolHandler", url]);
    expect(args[1]).toContain("&");
  });
});

it.skipIf(process.platform === "win32")("GRE-649 releases the core lock while a detached launcher survives", () => {
  const module = new URL("./bambu-connect.ts", import.meta.url).href;
  const source = `
import { tryLaunchBambuConnectUrl } from ${JSON.stringify(module)};
const result = await tryLaunchBambuConnectUrl("bambu-connect://test?name=a&path=b");
if (!result.launched) throw new Error(result.error);
console.log(process.pid);
setInterval(() => {}, 1000);
`;
  const probe = String.raw`
import fcntl, os, signal, subprocess, sys, tempfile, time
owner_source = """
import fcntl, os, subprocess, sys, time
with open(sys.argv[1], "w+b") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    os.dup2(lock.fileno(), 198, inheritable=True)
    child = subprocess.Popen([sys.argv[2], "--experimental-strip-types", "--input-type=module", "-e", sys.argv[3]], close_fds=False)
    child.wait()
"""
with tempfile.TemporaryDirectory() as directory:
    lock_path = directory + "/printpartner.lock"
    pid_path = directory + "/helper.pid"
    for name in ["open", "xdg-open"]:
        path = directory + "/" + name
        with open(path, "w") as helper:
            helper.write('#!/bin/sh\necho $$ > "$PP_HELPER_PID"\nexec /bin/sleep 60\n')
        os.chmod(path, 0o700)
    owner = subprocess.Popen([sys.executable, "-c", owner_source, lock_path, sys.argv[1], sys.argv[2]],
        env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"], "PP_STORAGE_CORE_LOCK": "1", "PP_HELPER_PID": pid_path}, stdout=subprocess.PIPE, text=True)
    node_pid = helper_pid = None
    try:
        node_pid = int(owner.stdout.readline())
        deadline = time.monotonic() + 5
        while not os.path.exists(pid_path) and time.monotonic() < deadline:
            time.sleep(.01)
        with open(pid_path) as pid_file:
            helper_pid = int(pid_file.read())
        with open(lock_path, "r+b") as contender:
            try:
                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                raise AssertionError("owner did not hold the lock")
            except BlockingIOError:
                pass
        os.kill(node_pid, signal.SIGKILL)
        owner.kill()
        owner.wait(timeout=5)
        os.kill(helper_pid, 0)
        state = subprocess.check_output(["ps", "-o", "stat=", "-p", str(helper_pid)], text=True).strip()
        assert state and not state.startswith("Z"), "detached helper already exited"
        with open(lock_path, "r+b") as contender:
            deadline = time.monotonic() + 5
            while True:
                try:
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(.01)
        print("lock released; detached helper alive")
    finally:
        for pid in [node_pid, helper_pid]:
            if pid:
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
        owner.kill()
        owner.wait(timeout=5)
`;
  const result = spawnSync("python3", ["-c", probe, process.execPath, source], { encoding: "utf8", timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("lock released; detached helper alive");
}, 60_000);
