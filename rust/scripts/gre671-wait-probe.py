"""GRE-671 diagnostic only: macOS waitid(WNOWAIT) and zombie process-group semantics."""
import ctypes, ctypes.util, errno, os, platform, signal, subprocess, sys, time

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
DARWIN = platform.system() == "Darwin"
P_PID = 1
WEXITED, WNOHANG = 4, 1
WNOWAIT = 0x20 if DARWIN else 0x01000000
SIGINFO = ctypes.c_char * 256  # larger than siginfo_t on both platforms

def si_pid(buf):
    # si_signo, si_errno, si_code are ints; Linux pads, Darwin puts si_pid next.
    words = (ctypes.c_int * 64).from_buffer(buf)
    return words[3] if DARWIN else words[4]

def trial():
    child = subprocess.Popen(["/bin/sh", "-c", "exit 7"], start_new_session=True)
    time.sleep(0.2)  # the child has exited and is a zombie
    group = libc.kill(-child.pid, 0)
    group_errno = ctypes.get_errno() if group else 0
    buf = SIGINFO()
    result = libc.waitid(P_PID, child.pid, buf, WEXITED | WNOHANG | WNOWAIT)
    seen = result == 0 and si_pid(buf) == child.pid
    try:
        pid, status = os.waitpid(child.pid, os.WNOHANG)
        after = f"waitpid ok status={os.waitstatus_to_exitcode(status) if pid else 'not-ready'}"
    except ChildProcessError:
        after = "waitpid ECHILD (already reaped by waitid)"
    return f"kill(-pgid,0)={'ok' if group == 0 else errno.errorcode.get(group_errno)} waitid_seen={seen} {after}"

print(platform.system(), platform.release())
results = [trial() for _ in range(int(sys.argv[1]) if len(sys.argv) > 1 else 20)]
for line in sorted(set(results)):
    print(f"GRE671 {results.count(line)}x {line}")
