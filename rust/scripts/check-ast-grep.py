"""Fail only when Rust ast-grep rule counts exceed the checked-in baseline."""

from collections import Counter
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


# Keywords have no ordinary identifier spelling. Replacing their raw prefix
# would change the parse, whereas non-keyword raw identifiers name the same item.
RUST_KEYWORDS = set("""
    as async await break const continue crate dyn else enum extern false fn for
    if impl in let loop match mod move mut pub ref return self Self static struct
    super trait true type unsafe use where while abstract become box do final
    gen macro override priv try typeof unsized virtual yield
""".split())
RAW_IDENTIFIER_RULE = """id: raw-identifier
language: Rust
rule:
  any:
    - kind: identifier
    - kind: type_identifier
  regex: '^r#'
"""


def command_hits_with_canonical_names(root, original_hits):
    """Canonicalize AST identifier nodes in a scan-only copy, keeping byte spans.

    Repeated YAML metavariables compare spelling, but Rust resolves r#p and p
    to the same name. The AST pass excludes strings and comments. Only affected
    files are rescanned, with the same crate-relative paths and exemptions.
    Other rules retain their original scan results.
    """
    raw_scan = subprocess.run(
        ["ast-grep", "scan", "--inline-rules", RAW_IDENTIFIER_RULE,
         "--json=compact", "crates"], cwd=root, text=True,
        capture_output=True, check=True,
    )
    edits = {}
    for node in json.loads(raw_scan.stdout):
        if node["text"][2:] not in RUST_KEYWORDS:
            edits.setdefault(node["file"], []).append(node["range"]["byteOffset"])
    if not edits:
        return original_hits
    with tempfile.TemporaryDirectory(prefix="pp-ast-grep-names-") as directory:
        copy = Path(directory)
        shutil.copy(root / "sgconfig.yml", copy)
        shutil.copytree(root / "rules", copy / "rules")
        for file, ranges in edits.items():
            relative = Path(file)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError(f"unexpected scanner path: {file}")
            data = bytearray((root / relative).read_bytes())
            for span in ranges:
                start = span["start"]
                if data[start:start + 2] != b"r#":
                    raise ValueError(f"invalid raw identifier span: {file}")
                data[start:start + 2] = b"  "
            target = copy / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        scan = subprocess.run(
            ["ast-grep", "scan", "--config", "sgconfig.yml", "--json=compact", "crates"],
            cwd=copy, text=True, capture_output=True, check=True,
        )
        hits = [hit for hit in original_hits
                if hit["ruleId"] != "runtime-process-command" or hit["file"] not in edits]
        for hit in json.loads(scan.stdout):
            if hit["ruleId"] == "runtime-process-command":
                # Report the original spelling; normalized spans have equal length.
                span = hit["range"]["byteOffset"]
                original = (root / hit["file"]).read_bytes()
                # The parser starts the canonical identifier after the two spaces.
                if span["start"] >= 2 and original[span["start"] - 2:span["start"]] == b"r#":
                    span["start"] -= 2
                    hit["range"]["start"]["column"] -= 2
                hit["text"] = original[span["start"]:span["end"]].decode()
                hits.append(hit)
        return hits


def main():
    root = Path(__file__).resolve().parents[1]
    baseline = json.loads((root / "ast-grep-baseline.json").read_text())
    if not isinstance(baseline, dict) or not baseline or any(type(value) is not int or value < 0 for value in baseline.values()):
        raise ValueError("ast-grep baseline must contain nonnegative integer counts")
    scan = subprocess.run(
        ["ast-grep", "scan", "--config", "sgconfig.yml", "--json=compact", "--inspect=entity", "crates"],
        cwd=root,
        text=True,
        capture_output=True,
        check=True,
    )
    # Use the pinned scanner's loaded-rule report, including rules with no hits.
    # A deleted, unconfigured, or disabled rule must not look like a decrease.
    loaded = {
        rule for rule, severity in re.findall(
            r"^sg: entity\|rule\|(.+): finalSeverity=(\w+)$", scan.stderr, re.MULTILINE
        ) if severity != "Off"
    }
    if loaded != baseline.keys():
        raise ValueError(
            f"ast-grep rule set differs from baseline: "
            f"unloaded={sorted(baseline.keys() - loaded)}, "
            f"unbaselined={sorted(loaded - baseline.keys())}"
        )
    hits = command_hits_with_canonical_names(root, json.loads(scan.stdout))
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
