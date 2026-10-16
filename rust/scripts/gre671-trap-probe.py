"""GRE-671 diagnostic only: does /bin/sh run a USR1 trap while blocked in `read`?"""
import os, signal, subprocess, sys, tempfile, time

SCRIPTS = {
    # The exact child script from ticket_t_2_process_exit_obeys_every_backoff_deadline_and_cap.
    "read-loop": r'''trap 'exit 7' USR1; read line || exit 0; data=${line#*'"data_dir":"'}; data=${data%%'"'*}; echo $$ > "$data/armed"; while read line; do :; done''',
    # POSIX: a trapped signal makes the `wait` builtin return at once.
    "wait-idiom": r'''trap 'exit 7' USR1; read line || exit 0; data=${line#*'"data_dir":"'}; data=${data%%'"'*}; echo $$ > "$data/armed"; exec 3<&0; while read line <&3; do :; done & wait $!''',
}

def trial(script, delay):
    data = tempfile.mkdtemp()
    child = subprocess.Popen(["/bin/sh", "-c", script], stdin=subprocess.PIPE,
                             env={"PATH": "/usr/bin:/bin"}, start_new_session=True)
    child.stdin.write(('{"data_dir":"%s"}\n' % data).encode()); child.stdin.flush()
    armed = os.path.join(data, "armed")
    deadline = time.time() + 5
    while not (os.path.exists(armed) and open(armed).read().strip() == str(child.pid)):
        if time.time() > deadline:
            child.kill(); return "never-armed"
        time.sleep(0.001)
    time.sleep(delay)
    os.kill(child.pid, signal.SIGUSR1)
    try:
        code = child.wait(timeout=5)
        result = f"exit {code}"
    except subprocess.TimeoutExpired:
        result = "HANG"
    os.killpg(child.pid, signal.SIGKILL) if result == "HANG" else None
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    child.stdin.close()
    return result

print("sh:", subprocess.run(["/bin/sh", "--version"], capture_output=True, text=True).stdout.splitlines()[:1] or "(no --version)")
for name, script in SCRIPTS.items():
    for delay in (0.0, 0.2):
        results = [trial(script, delay) for _ in range(int(sys.argv[1]) if len(sys.argv) > 1 else 20)]
        counts = {r: results.count(r) for r in sorted(set(results))}
        print(f"GRE671 {name} delay={delay}s {counts}")
