"""Repeat the GRE-634 process-group tests under CPU load, stopping on failure."""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import time


TESTS = (
    "tests::separate_group_child_dies_with_force_killed_parent",
    "tests::ticket_t_3_drain_reaps_group_when_leader_wait_fails",
)
SUBREAPER = "tests::ticket_t_3_drain_leader_exit_with_forced_descendant_reports_forced"


def stress_group_cleanup_self_tests():
    import unittest

    suite = unittest.defaultTestLoader.discover(
        str(Path(__file__).resolve().parent),
        pattern="test_stress_group_cleanup.py",
    )
    if suite.countTestCases() == 0:
        print("FAIL: no stress runner self-tests found", file=sys.stderr)
        return 1
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


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
    listing = subprocess.check_output([str(binary), "--list"], text=True)
    tests = {line.removesuffix(": test") for line in listing.splitlines() if line.endswith(": test")}
    listing = subprocess.check_output([str(binary), "--list", "--ignored"], text=True)
    ignored = {line.removesuffix(": test") for line in listing.splitlines() if line.endswith(": test")}
    required = (*TESTS, SUBREAPER) if args.scope == "pair" else TESTS
    missing = set(required) - (tests - ignored)
    if missing:
        parser.error("required tests are missing or ignored: " + ", ".join(sorted(missing)))
    expected = {"alone": 1, "pair": 2, "suite": len(tests - ignored)}[args.scope]
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
            SUBREAPER,
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
                contents = log.read_text()
                summaries = re.findall(
                    r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; (\d+) filtered out;",
                    contents,
                )
                passed = False
                if summaries:
                    status, count, failed, skipped, filtered = summaries[-1]
                    passed = status == "ok" and int(count) == expected and int(failed) == 0
                    if args.scope == "suite":
                        passed = passed and int(filtered) == 0 and int(skipped) == len(ignored)
                if result.returncode != 0 or not passed:
                    print(contents, flush=True)
                    with (evidence / "failure-processes.log").open("w") as output:
                        subprocess.run(
                            ["ps", "-e", "-o", "pid,ppid,pgid,sid,stat,comm"],
                            stdout=output,
                            check=True,
                        )
                    print(
                        f"FAIL run={run} exit={result.returncode} summary_valid={passed} "
                        f"command={command} log={log}",
                        flush=True,
                    )
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
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(stress_group_cleanup_self_tests())
    if "--self-test" in sys.argv[1:]:
        print(
            f"{Path(sys.argv[0]).name}: error: --self-test must be the only argument",
            file=sys.stderr,
        )
        sys.exit(2)
    sys.exit(main())
