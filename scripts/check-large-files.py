#!/usr/bin/env python3
"""Fail when a file in the Git index is larger than the repository limit.

It reads blob sizes from the index, so CI checks the commit and the opt-in
pre-commit hook checks exactly what is staged. Usage:
python3 scripts/check-large-files.py [--limit BYTES]
"""

import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
# The largest tracked file is a 1.2 MB parity fixture. Larger data belongs in
# a generator or a release artifact, not in Git history.
LIMIT = 1_572_864
GITLINK = "160000"


def git(root, *args, data=None):
    return subprocess.run(["git", *args], cwd=root, input=data, capture_output=True,
                          check=True).stdout


def oversized(root, limit):
    entries = []
    for record in git(root, "ls-files", "-s", "-z").split(b"\0"):
        if not record:
            continue
        meta, path = record.split(b"\t", 1)
        mode, blob, _stage = meta.decode().split()
        if mode != GITLINK:
            entries.append((blob, path.decode("utf-8", "surrogateescape")))
    if not entries:
        return []
    query = "".join(f"{blob}\n" for blob, _ in entries).encode()
    sizes = git(root, "cat-file", "--batch-check=%(objectsize)", data=query).split()
    return [(path, int(size)) for (_, path), size in zip(entries, sizes) if int(size) > limit]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, default=LIMIT, help="maximum bytes per file")
    args = parser.parse_args(argv)
    found = oversized(ROOT, args.limit)
    for path, size in found:
        print(f"{path}: {size} bytes exceeds the {args.limit}-byte limit", file=sys.stderr)
    if found:
        print("Generate large fixtures at test time or publish them as artifacts.", file=sys.stderr)
        return 1
    print(f"Large-file check: every indexed file is at most {args.limit} bytes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
