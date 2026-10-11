"""Fail only when Rust ast-grep rule counts exceed the checked-in baseline."""

from collections import Counter
import json
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    baseline = json.loads((root / "ast-grep-baseline.json").read_text())
    if not baseline or any(type(value) is not int or value < 0 for value in baseline.values()):
        raise ValueError("ast-grep baseline must contain nonnegative integer counts")
    scan = subprocess.run(
        ["ast-grep", "scan", "--config", "sgconfig.yml", "--json=compact", "crates"],
        cwd=root,
        text=True,
        capture_output=True,
        check=True,
    )
    hits = json.loads(scan.stdout)
    counts = Counter(hit["ruleId"] for hit in hits)
    unknown = counts.keys() - baseline.keys()
    if unknown:
        raise ValueError(f"rules missing from ast-grep baseline: {sorted(unknown)}")
    increased = {rule for rule, allowed in baseline.items() if counts[rule] > allowed}
    for rule, allowed in baseline.items():
        print(f"{rule}: {counts[rule]} hits (baseline {allowed})")
    for hit in hits:
        if hit["ruleId"] in increased:
            line = hit["range"]["start"]["line"] + 1
            print(f'{hit["file"]}:{line}: {hit["ruleId"]}: {hit["text"]}')
    if increased:
        print("ast-grep ratchet FAILED: hits exceed the baseline.")
        return 1
    print("ast-grep ratchet passed: no hits beyond the baseline.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"ast-grep ratchet error: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        sys.exit(2)
