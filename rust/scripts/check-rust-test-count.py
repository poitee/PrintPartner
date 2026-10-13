"""Reject successful Rust test commands that executed no required tests."""

import argparse
from pathlib import Path
import re


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("--exact", help="Require this named test and exactly one passed test")
    args = parser.parse_args()
    output = args.log.read_text()
    results = re.findall(
        r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;",
        output,
        re.MULTILINE,
    )
    if not results or any(status != "ok" or int(failed) for status, _, failed, _ in results):
        parser.exit(1, "Required Rust tests did not complete successfully\n")
    if args.exact:
        _, passed, _, ignored = results[-1]
        named = re.search(r"^test " + re.escape(args.exact) + r" \.\.\.", output, re.MULTILINE)
        if not named or int(passed) != 1 or int(ignored) != 0:
            parser.exit(1, f"Required Rust test {args.exact!r} did not execute exactly once\n")
        count = 1
    else:
        count = sum(int(passed) for _, passed, _, _ in results)
        if count == 0:
            parser.exit(1, "Required Rust test suite executed zero tests\n")
    print(f"Verified {count} passed Rust test(s)")


if __name__ == "__main__":
    main()
