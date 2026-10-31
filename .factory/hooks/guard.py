#!/usr/bin/env python3
"""Block agent actions that Print Partner reserves for the maintainer.

Droid runs this before Execute, Create, Edit, and ApplyPatch calls, including
inside Missions. It is a guard rail, not a security boundary: it reads the
tool input Droid supplies and refuses known-dangerous shapes.
"""

import json
from pathlib import PurePosixPath
import re
import sys

GIT = r"\bgit(?:\s+-C\s+(?:\"[^\"]*\"|'[^']*'|\S+))*\s+"
COMMAND_RULES = (
    (re.compile(r"\bgh\s+pr\s+merge\b"), "Merging is the maintainer's job. Report readiness instead."),
    (re.compile(r"\bgh\s+api\b(?=[^;&|\n]*(?:-X\s*|--method[= ])PUT\b)[^;&|\n]*/pulls/\d+/merge\b"),
     "Merging is the maintainer's job. Report readiness instead."),
    (re.compile(GIT + r"push\b[^;&|\n]*(\s--force\b|\s--force-with-lease\b|\s-[a-zA-Z]*f\b|\s\+\S)"),
     "Never force-push. Add a commit instead."),
    (re.compile(GIT + r"push\b[^;&|\n]*[ \t](\S+:)?(refs/heads/)?main(?:\s|[;&|]|$)"), "Push a branch and open a PR; main only changes by merge."),
    (re.compile(GIT + r"push\b[^;&|\n]*\s--tags\b|\bgh\s+release\s+create\b"), "Releases and tags need separate authorization."),
    (re.compile(r"--no-verify\b"), "Do not bypass Git hooks."),
)

GENERATED = {"rust/bundle-manifest.json"}
PATCH_FILE = re.compile(r"^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$", re.M)


def protected_path(raw):
    path = PurePosixPath(raw.replace("\\", "/"))
    name = path.name
    if ".git" in path.parts:
        return "Do not edit Git metadata."
    if (name == ".env" or name.startswith(".env.")) and not name.endswith(".example"):
        return "Keep real environment files out of agent edits; use the .example template."
    if any(raw.replace("\\", "/").endswith(entry) for entry in GENERATED):
        return "This file is generated. Run its generator instead of editing it."
    return None


def decide(payload):
    if not isinstance(payload, dict):
        return "Expected a JSON object."
    tool = payload.get("tool_name", "")
    data = payload.get("tool_input", {})
    if not isinstance(data, dict) and not (tool == "ApplyPatch" and isinstance(data, str)):
        return "Expected object tool input, or a patch string for ApplyPatch."
    if tool == "Execute":
        command = str(data.get("command", "")).replace("\\\r\n", "").replace("\\\n", "")
        for pattern, reason in COMMAND_RULES:
            if pattern.search(command):
                return reason
        return None
    paths = []
    if tool in ("Create", "Edit"):
        paths.append(str(data.get("file_path", "")))
    elif tool == "ApplyPatch":
        text = data if isinstance(data, str) else str(data.get("input") or data.get("patch") or "")
        paths.extend(PATCH_FILE.findall(text))
    for path in paths:
        reason = protected_path(path.strip())
        if reason:
            return f"{path}: {reason}"
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        print("pp guard: unreadable hook input", file=sys.stderr)
        return 2
    reason = decide(payload)
    if reason:
        print(f"pp guard: {reason}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
