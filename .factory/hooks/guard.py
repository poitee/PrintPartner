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

MERGE = "Merging is the maintainer's job. Report readiness instead."
FORCE = "Never force-push. Add a commit instead."
MAIN = "Push a branch and open a PR; main only changes by merge."
RELEASE = "Releases and tags need separate authorization."
HOOKS = "Do not bypass Git hooks."

ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
WRAPPERS = {"command", "env", "exec", "nohup", "time"}
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
HOOK_COMMANDS = {"am", "cherry-pick", "commit", "merge", "push", "rebase", "revert"}
MAIN_REF = re.compile(r"^(?:[^:]*:)?(?:refs/heads/)?main$")
PR_MERGE_PATH = re.compile(r"(?:^|/)pulls/\d+/merge/?$")
PUSH_VALUE_LONG = {"--exec", "--push-option", "--receive-pack", "--repo"}
COMMIT_VALUE_LONG = {"--author", "--date", "--file", "--message", "--reedit-message",
                     "--reuse-message", "--template", "--trailer"}
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


SEPARATORS = ";&|\n()"
HEREDOC = re.compile(r"""[ \t]*((?:'[^']*'|"[^"]*"|\\.|[^\s;&|<>()'"\\])+)""")
HEREDOC_QUOTING = re.compile(r"""\\(.)|['"]""")


def shell_commands(source):
    """Split shell source into simple commands of unquoted arguments.

    Handles quotes, escapes, separators, comments, and heredoc bodies. It does
    not evaluate expansions, so it is a mistake guard rather than a sandbox.
    """
    commands, args, word, heredocs = [], [], None, []

    def finish_word():
        nonlocal word
        if word is not None:
            args.append(word)
            word = None

    i = 0
    while i < len(source):
        char = source[i]
        if char == "\\" and i + 1 < len(source):
            word = (word or "") + source[i + 1]
            i += 2
        elif char in "'\"":
            j, text = i + 1, []
            while True:
                if j >= len(source):
                    raise ValueError("unterminated quote")
                c = source[j]
                if c == char:
                    break
                if char == '"' and c == "\\" and source[j + 1:j + 2] in ('$', '`', '"', "\\"):
                    text.append(source[j + 1])
                    j += 2
                    continue
                text.append(c)
                j += 1
            word = (word or "") + "".join(text)
            i = j + 1
        elif char == "#" and word is None:
            newline = source.find("\n", i)
            i = len(source) if newline < 0 else newline
        elif source.startswith("<<<", i):
            finish_word()
            i += 3
        elif source.startswith("<<", i):
            finish_word()
            i += 2
            tabs = source.startswith("-", i)
            i += tabs
            match = HEREDOC.match(source, i)
            if match:
                delimiter = HEREDOC_QUOTING.sub(lambda m: m.group(1) or "", match.group(1))
                heredocs.append((delimiter, tabs))
                i = match.end()
        elif char in " \t\r<>" or char in SEPARATORS:
            finish_word()
            if char in SEPARATORS and args:
                commands.append(args)
                args = []
            i += 1
            if char == "\n":
                for delimiter, tabs in heredocs:
                    while i < len(source):
                        end = source.find("\n", i)
                        end = len(source) if end < 0 else end
                        line = source[i:end].rstrip("\r")
                        i = end + 1
                        if (line.lstrip("\t") if tabs else line) == delimiter:
                            break
                heredocs = []
        else:
            word = (word or "") + char
            i += 1
    finish_word()
    if args:
        commands.append(args)
    return commands

def program(args):
    """Return the executed program name and its arguments after assignments and wrappers."""
    i = 0
    while i < len(args):
        if ASSIGNMENT.match(args[i]):
            i += 1
        elif PurePosixPath(args[i]).name in WRAPPERS:
            i += 1
            while i < len(args) and args[i].startswith("-"):
                i += 1
        else:
            return PurePosixPath(args[i]).name, args[i + 1:]
    return None, []


def options(args, value_flags="", stop_flags="", value_long=()):
    """Yield ("long" | "short" | "arg", text) for one command's arguments.

    A short bundle stops at a flag that takes a value; when that value is the
    next argument, it is skipped rather than read as another option.
    """
    i, ended = 0, False
    while i < len(args):
        arg = args[i]
        i += 1
        if not ended and arg == "--":
            ended = True
        elif ended or arg == "-" or not arg.startswith("-"):
            yield "arg", arg
        elif arg.startswith("--"):
            yield "long", arg.split("=", 1)[0]
            if arg in value_long:
                i += 1
        else:
            flags = ""
            for char in arg[1:]:
                flags += char
                if char in value_flags or char in stop_flags:
                    break
            yield "short", flags
            if flags[-1:] in tuple(value_flags) and len(flags) == len(arg) - 1:
                i += 1


def git_reason(args):
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in GIT_VALUE_OPTIONS else 1
    if i >= len(args):
        return None
    command, rest = args[i], args[i + 1:]
    if command == "push":
        parsed = list(options(rest, value_flags="o", value_long=PUSH_VALUE_LONG))
        for kind, arg in parsed:
            if (kind == "long" and arg in ("--force", "--force-with-lease")
                    or kind == "short" and "f" in arg or kind == "arg" and arg.startswith("+")):
                return FORCE
        if any(kind == "long" and arg in ("--tags", "--follow-tags") for kind, arg in parsed):
            return RELEASE
        if any(kind == "arg" and MAIN_REF.match(arg) for kind, arg in parsed):
            return MAIN
    if command in HOOK_COMMANDS:
        parsed = options(rest, value_flags="mFcCt", stop_flags="uS", value_long=COMMIT_VALUE_LONG)
        for kind, arg in parsed:
            if kind == "long" and arg == "--no-verify" or command == "commit" and kind == "short" and "n" in arg:
                return HOOKS
    return None


def gh_reason(args):
    while args[:1] in (["-R"], ["--repo"]):
        args = args[2:]
    if args[:2] == ["pr", "merge"]:
        return MERGE
    if args[:2] == ["release", "create"]:
        return RELEASE
    if args[:1] != ["api"]:
        return None
    method, targets, i = None, [], 1
    while i < len(args):
        arg = args[i]
        i += 1
        if arg in ("-X", "--method"):
            method = args[i] if i < len(args) else None
            i += 1
        elif arg.startswith("--method="):
            method = arg.split("=", 1)[1]
        elif arg.startswith("-X"):
            method = arg[2:]
        else:
            targets.append(arg)
    if (method or "").upper() == "PUT" and any(PR_MERGE_PATH.search(t) for t in targets):
        return MERGE
    if "graphql" in targets and any(re.search(r"\b(?:mergePullRequest|enablePullRequestAutoMerge)\b", t)
                                    for t in targets):
        return MERGE
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
        try:
            for args in shell_commands(command):
                name, rest = program(args)
                reason = git_reason(rest) if name == "git" else gh_reason(rest) if name == "gh" else None
                if reason:
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
