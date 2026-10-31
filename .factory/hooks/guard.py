#!/usr/bin/env python3
"""Block agent actions that Print Partner reserves for the maintainer.

Droid runs this before Execute, Create, Edit, and ApplyPatch calls, including
inside Missions. It is a guard rail, not a security boundary: it reads the
tool input Droid supplies and refuses known-dangerous shapes.
"""

import json
from pathlib import PurePosixPath
import re
import shlex
import sys

GIT = r"^git(?:\s+-C\s+(?:\"[^\"]*\"|'[^']*'|\S+))*\s+"
COMMAND_RULES = (
    (re.compile(r"^gh\s+pr\s+merge\b"), "Merging is the maintainer's job. Report readiness instead."),
    (re.compile(r"^gh\s+api\b(?=[^;&|\n]*(?:-X\s*|--method[= ])PUT\b)[^;&|\n]*/pulls/\d+/merge\b"),
     "Merging is the maintainer's job. Report readiness instead."),
    (re.compile(GIT + r"push\b[^;&|\n]*(\s--force(?=\s|$)|\s--force-with-lease(?:=|\s|$)|\s-[a-zA-Z]*f\b|\s\+\S)"),
     "Never force-push. Add a commit instead."),
    (re.compile(GIT + r"push\b[^;&|\n]*[ \t](\S+:)?(refs/heads/)?main(?:\s|[;&|]|$)"), "Push a branch and open a PR; main only changes by merge."),
    (re.compile(GIT + r"push\b[^;&|\n]*\s--tags\b|^gh\s+release\s+create\b"), "Releases and tags need separate authorization."),
    (re.compile(GIT + r"(?:commit|push|merge|rebase|am|cherry-pick|revert)\b.*\s--no-verify(?=\s|$)"),
     "Do not bypass Git hooks."),
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
    if any(path.as_posix().endswith(entry) for entry in GENERATED):
        return "This file is generated. Run its generator instead of editing it."
    return None


def shell_commands(source):
    """Extract simple commands, excluding quoted literals and heredoc bodies.

    This deliberately handles common shell shapes, not shell evaluation.
    """
    lines, pending = [], []
    for line in source.splitlines(keepends=True):
        if pending:
            delimiter, tabs = pending[0]
            if (line.lstrip("\t") if tabs else line).rstrip("\r\n") == delimiter:
                pending.pop(0)
            continue
        lines.append(line)
        lexer = shlex.shlex(line, posix=False, punctuation_chars="<>")
        lexer.whitespace_split = True
        try:
            tokens = list(lexer)
        except ValueError:
            continue  # A multiline quoted string is parsed by the lexer below.
        for i, token in enumerate(tokens[:-1]):
            if token == "<<":
                delimiter = tokens[i + 1]
                tabs = delimiter.startswith("-")
                pending.append((delimiter.lstrip("-").strip("'\""), tabs))
    lexer = shlex.shlex("".join(lines), posix=False, punctuation_chars=";&|\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    command = []
    for token in lexer:
        if token and all(char in ";&|\n" for char in token):
            if command:
                yield command
                command = []
        else:
            command.append(shlex.split(token)[0])
    if command:
        yield command


def decide(payload):
    if not isinstance(payload, dict):
        return "Expected a JSON object."
    tool = payload.get("tool_name", "")
    data = payload.get("tool_input", {})
    if not isinstance(data, dict) and not (tool == "ApplyPatch" and isinstance(data, str)):
        return "Expected object tool input, or a patch string for ApplyPatch."
    if tool == "Execute":
        command = str(data.get("command", "")).replace("\\\r\n", "").replace("\\\n", "")
        try:
            for args in shell_commands(command):
                if args[0] not in ("git", "gh"):
                    continue
                # Preserve spaces within arguments, but remove unnecessary quotes.
                executable = " ".join(shlex.quote(arg) if any(c.isspace() for c in arg) else arg
                                      for arg in args)
                for pattern, reason in COMMAND_RULES:
                    if pattern.search(executable):
                        return reason
        except ValueError:
            return "Cannot parse shell command; use a simpler command."
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
