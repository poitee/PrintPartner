"""Fail unless Rust ast-grep rule counts equal the checked-in baseline.

The baseline may not rise over origin/main unless PP_AST_GREP_ALLOW_BASELINE_RAISE=1.
"""

from collections import Counter
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


BASE_REF = "origin/main"
RAISE_OVERRIDE = "PP_AST_GREP_ALLOW_BASELINE_RAISE"


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


def parse_baseline(text):
    baseline = json.loads(text)
    if not isinstance(baseline, dict) or not baseline or any(type(value) is not int or value < 0 for value in baseline.values()):
        raise ValueError("ast-grep baseline must contain nonnegative integer counts")
    return baseline


def main_baseline(root):
    """Return the baseline at BASE_REF, or None before it first lands there.

    A missing BASE_REF is an error, so an unfetched checkout cannot skip the rise check.
    """
    if subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", BASE_REF + "^{commit}"],
        cwd=root, capture_output=True,
    ).returncode:
        raise ValueError(f"{BASE_REF} is unavailable; fetch it so baseline raises can be checked")
    spec = f"{BASE_REF}:./ast-grep-baseline.json"
    if subprocess.run(["git", "cat-file", "-e", spec], cwd=root, capture_output=True).returncode:
        return None
    shown = subprocess.run(["git", "show", spec], cwd=root, text=True, capture_output=True, check=True)
    return parse_baseline(shown.stdout)


def raised_over_main(baseline, main):
    """Map each rule whose baseline rose to (main, local). Rules absent from main count as zero."""
    return {
        rule: (main.get(rule, 0), allowed)
        for rule, allowed in baseline.items()
        if allowed > main.get(rule, 0)
    }


def main():
    root = Path(__file__).resolve().parents[1]
    baseline = parse_baseline((root / "ast-grep-baseline.json").read_text())
    main = main_baseline(root)
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
    exceeded = {rule for rule, allowed in baseline.items() if counts[rule] > allowed}
    lowered = {rule for rule, allowed in baseline.items() if counts[rule] < allowed}
    raised = {} if main is None else raised_over_main(baseline, main)
    allow_raise = os.environ.get(RAISE_OVERRIDE) == "1"
    for rule, allowed in baseline.items():
        print(f"{rule}: {counts[rule]} hits (baseline {allowed})")
    for hit in hits:
        if hit["ruleId"] in exceeded:
            line = hit["range"]["start"]["line"] + 1
            print(f'{hit["file"]}:{line}: {hit["ruleId"]}: {hit["text"]}')
    if main is None:
        print(f"ast-grep baseline raise check skipped: {BASE_REF} has no ast-grep-baseline.json yet (first landing).")
    for rule, (before, after) in raised.items():
        print(f"{rule}: baseline raised {before} -> {after} over {BASE_REF}")
    status = 0
    if exceeded:
        print("ast-grep ratchet FAILED: hits exceed the baseline.")
        status = 1
    if lowered:
        print(f"ast-grep ratchet FAILED: baseline must equal hit counts; lower ast-grep-baseline.json for {sorted(lowered)}.")
        status = 1
    if raised and not allow_raise:
        print(f"ast-grep ratchet FAILED: baseline raised over {BASE_REF}; set {RAISE_OVERRIDE}=1 only for an intentional raise.")
        status = 1
    if status == 0:
        print("ast-grep ratchet passed: counts match the baseline.")
    return status


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"ast-grep ratchet error: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        sys.exit(2)
