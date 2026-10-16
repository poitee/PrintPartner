"""Repeat the GRE-634 process-group tests under CPU load, stopping on failure."""

import argparse
import os
from pathlib import Path
import subprocess
import sys
import time


TESTS = (
    "tests::separate_group_child_dies_with_force_killed_parent",
    "tests::ticket_t_3_drain_reaps_group_when_leader_wait_fails",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=200)
    parser.add_argument("--scope", choices=("alone", "pair", "suite"), required=True)
    parser.add_argument("--burners", type=int, default=4)
    parser.add_argument("--cpus", type=int, default=2)
    parser.add_argument("--test-threads", type=int, default=12)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    if min(args.runs, args.cpus, args.test_threads) < 1 or args.burners < 0:
        parser.error("runs, cpus and test threads must be positive; burners must be nonnegative")
    binary = args.binary.resolve(strict=True)
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    if hasattr(os, "sched_getaffinity"):
        cpus = sorted(os.sched_getaffinity(0))[-args.cpus :]
        os.sched_setaffinity(0, cpus)
        print(f"cpus={cpus}", flush=True)
    if args.scope == "alone":
        commands = [[str(binary), "--exact", test, "--nocapture"] for test in TESTS]
    elif args.scope == "pair":
        commands = [[
            str(binary), TESTS[1],
            "tests::ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced",
            "--nocapture", "--test-threads=2",
        ]]
    else:
        commands = [[str(binary), "--nocapture", f"--test-threads={args.test_threads}"]]
    burners = []
    started = time.monotonic()
    try:
        for _ in range(args.burners):
            burners.append(subprocess.Popen([sys.executable, "-c", "while True: pass"]))
        for run in range(1, args.runs + 1):
            for index, command in enumerate(commands):
                log = evidence / f"{run:03}-{index}.log"
                with log.open("w") as output:
                    result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
                expected = [command[2]] if args.scope == "alone" else [TESTS[1]]
                if args.scope == "suite":
                    expected = TESTS
                passed = all(f"test {test} ... ok" in log.read_text() for test in expected)
                if result.returncode != 0 or not passed:
                    print(log.read_text(), flush=True)
                    with (evidence / "failure-processes.log").open("w") as output:
                        subprocess.run(
                            ["ps", "-e", "-o", "pid,ppid,pgid,sid,stat,comm"],
                            stdout=output,
                            check=True,
                        )
                    print(f"FAIL run={run} command={command} log={log}", flush=True)
                    return 1
            if run == 1 or run % 10 == 0 or run == args.runs:
                print(
                    f"PASS scope={args.scope} runs={run}/{args.runs} "
                    f"commands_per_run={len(commands)} burners={args.burners} "
                    f"elapsed={time.monotonic() - started:.1f}s",
                    flush=True,
                )
        return 0
    finally:
        for burner in burners:
            burner.terminate()
        for burner in burners:
            burner.wait()


if __name__ == "__main__":
    sys.exit(main())
