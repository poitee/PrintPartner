#!/usr/bin/env python3
"""Block agent actions that Print Partner reserves for the maintainer.

Droid runs this before Execute, Create, Edit, and ApplyPatch calls, including
inside Missions. It is a guard rail, not a security boundary: it reads the
tool input Droid supplies and refuses known-dangerous shapes. When it cannot
classify a git or gh invocation, it refuses rather than guessing.
"""

import json
import os
from pathlib import Path, PurePosixPath
import re
import sys

MERGE = "Merging is the maintainer's job. Report readiness instead."
FORCE = "Never force-push. Add a commit instead."
MAIN = "Push a branch and open a PR; main only changes by merge."
RELEASE = "Releases and tags need separate authorization."
HOOKS = "Do not bypass Git hooks."
UNCLEAR = "Cannot classify this git or gh command; run it without the wrapper option."
UNPARSABLE = "Cannot parse shell command; use a simpler command."

ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
SHELL_PREFIXES = {"!", "{", "}", "if", "then", "elif", "else", "while", "until", "do"}
# Wrapper programs and their options that take a separate value.
WRAPPERS = {
    "command": set(),
    "env": {"-u", "--unset", "-C", "--chdir"},
    "exec": {"-a"},
    "nohup": set(),
    "sudo": {"-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "-D", "-R", "-T", "-U"},
    "nice": {"-n", "--adjustment"},
    "time": {"-f", "--format", "-o", "--output"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
}
# Positional operands, such as a duration, that come before the wrapped program.
WRAPPER_OPERANDS = {"timeout": 1}
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
HOOK_COMMANDS = {"am", "cherry-pick", "merge", "rebase", "revert"}
MAIN_REF = re.compile(r"^(?:refs/heads/)?main$")
PUSH_VALUE_LONG = {"--exec", "--push-option", "--receive-pack", "--repo"}
COMMIT_VALUE_LONG = {"--author", "--date", "--file", "--message", "--reedit-message",
                     "--reuse-message", "--template", "--trailer"}
GH_VALUE_OPTIONS = {"-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq",
                    "-t", "--template", "--hostname", "-p", "--preview", "--cache", "-X", "--method"}
PR_MERGE_PATH = re.compile(r"(?:^|/)pulls/\d+/merge/?$")
MERGE_MUTATION = re.compile(r"\b(?:mergePullRequest|enablePullRequestAutoMerge)\s*\(")
GENERATED = {"rust/bundle-manifest.json"}
PATCH_FILE = re.compile(r"^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$", re.M)


class Unclear(Exception):
    pass


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


def closing_paren(source, i):
    depth = 1
    while i < len(source):
        char = source[i]
        if char == "\\":
            i += 2
            continue
        if char in "'\"":
            end = source.find(char, i + 1)
            if end < 0:
                raise ValueError("unterminated quote")
            i = end + 1
            continue
        depth += {"(": 1, ")": -1}.get(char, 0)
        if depth == 0:
            return i
        i += 1
    raise ValueError("unterminated command substitution")


def closing_backtick(source, i):
    end = source.find("`", i)
    if end < 0:
        raise ValueError("unterminated command substitution")
    return end


def shell_commands(source):
    """Split shell source into simple commands of unquoted arguments.

    Handles quotes, escapes, continuations, separators, comments, redirections,
    heredoc bodies, and command substitutions. It does not evaluate expansions.
    """
    commands, args, word, heredocs, nested = [], [], None, [], []
    drop_next = False

    def finish_word():
        nonlocal word, drop_next
        if word is not None:
            if drop_next:
                drop_next = False
            else:
                args.append(word)
            word = None

    i = 0
    while i < len(source):
        char = source[i]
        if char == "\\" and i + 1 < len(source):
            if source[i + 1] == "\n":
                i += 2
            elif source.startswith("\r\n", i + 1):
                i += 3
            else:
                word = (word or "") + source[i + 1]
                i += 2
        elif char == "'":
            end = source.find("'", i + 1)
            if end < 0:
                raise ValueError("unterminated quote")
            word = (word or "") + source[i + 1:end]
            i = end + 1
        elif char == '"':
            j, text = i + 1, []
            while True:
                if j >= len(source):
                    raise ValueError("unterminated quote")
                c = source[j]
                if c == '"':
                    break
                if c == "\\" and source[j + 1:j + 2] == "\n":
                    j += 2
                elif c == "\\" and source[j + 1:j + 2] in ("$", "`", '"', "\\"):
                    text.append(source[j + 1])
                    j += 2
                elif source.startswith("$(", j):
                    end = closing_paren(source, j + 2)
                    nested.append(source[j + 2:end])
                    j = end + 1
                elif c == "`":
                    end = closing_backtick(source, j + 1)
                    nested.append(source[j + 1:end])
                    j = end + 1
                else:
                    text.append(c)
                    j += 1
            word = (word or "") + "".join(text)
            i = j + 1
        elif source.startswith("$(", i):
            end = closing_paren(source, i + 2)
            nested.append(source[i + 2:end])
            word = word or ""
            i = end + 1
        elif char == "`":
            end = closing_backtick(source, i + 1)
            nested.append(source[i + 1:end])
            word = word or ""
            i = end + 1
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
        elif char in "<>" or source.startswith("&>", i):
            if word is not None and word.isdigit():
                word = None
            finish_word()
            i += 1
            while i < len(source) and source[i] in "<>&|":
                i += 1
            drop_next = True
        elif char in " \t\r" or char in SEPARATORS:
            finish_word()
            if char in SEPARATORS:
                drop_next = False
                if args:
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
    for inner in nested:
        commands.extend(shell_commands(inner))
    return commands


def program(args):
    """Return the executed program name and its arguments."""
    i = 0
    while i < len(args):
        word = args[i]
        if ASSIGNMENT.match(word) or word in SHELL_PREFIXES:
            i += 1
            continue
        name = PurePosixPath(word).name
        if name not in WRAPPERS:
            return name, args[i + 1:]
        i += 1
        while i < len(args) and args[i].startswith("-"):
            option = args[i]
            if option == "--":
                i += 1
                break
            if name == "env" and (option.startswith("--split-string") or re.match(r"^-[^-]*S", option)):
                raise Unclear
            i += 2 if option in WRAPPERS[name] else 1
        i += WRAPPER_OPERANDS.get(name, 0)
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


def push_reason(args):
    parsed = list(options(args, value_flags="o", value_long=PUSH_VALUE_LONG))
    longs = {arg for kind, arg in parsed if kind == "long"}
    shorts = "".join(arg for kind, arg in parsed if kind == "short")
    positional = [arg for kind, arg in parsed if kind == "arg"]
    if "--dry-run" in longs or "n" in shorts:
        return None
    if "--no-verify" in longs:
        return HOOKS
    refspecs = positional if "--repo" in longs else positional[1:]
    if longs & {"--force", "--force-with-lease", "--mirror"} or "f" in shorts:
        return FORCE
    if any(refspec.startswith("+") for refspec in refspecs):
        return FORCE
    if longs & {"--tags", "--follow-tags"} or "tag" in refspecs or any("refs/tags/" in r for r in refspecs):
        return RELEASE
    if longs & {"--all", "--branches"} or any(MAIN_REF.match(r.rsplit(":", 1)[-1]) for r in refspecs):
        return MAIN
    return None


def git_reason(args):
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in GIT_VALUE_OPTIONS else 1
    if i >= len(args):
        return None
    command, rest = args[i], args[i + 1:]
    if command == "push":
        return push_reason(rest)
    if command == "commit":
        parsed = options(rest, value_flags="mFcCt", stop_flags="uS", value_long=COMMIT_VALUE_LONG)
        if any(kind == "long" and arg == "--no-verify" or kind == "short" and "n" in arg
               for kind, arg in parsed):
            return HOOKS
    elif command in HOOK_COMMANDS:
        if any(kind == "long" and arg == "--no-verify" for kind, arg in options(rest)):
            return HOOKS
    return None


def graphql_query(flag, value, cwd):
    key, _, text = value.partition("=")
    if key != "query":
        return ""
    if flag in ("-F", "--field") and text.startswith("@"):
        try:
            return (Path(cwd) / text[1:]).read_text(encoding="utf-8")
        except OSError:
            return ""
    return text


def gh_reason(args, cwd):
    while args and (args[0] in ("-R", "--repo") or args[0].startswith(("-R", "--repo="))):
        args = args[2:] if args[0] in ("-R", "--repo") else args[1:]
    if args[:1] == ["help"] or "--help" in args or "-h" in args:
        return None
    if args[:2] == ["pr", "merge"]:
        return MERGE
    if args[:2] == ["release", "create"]:
        return RELEASE
    if args[:1] != ["api"]:
        return None
    method, endpoint, fields, i = None, None, [], 1
    while i < len(args):
        arg = args[i]
        i += 1
        if arg.startswith("--"):
            name, attached, value = arg.partition("=")
        elif arg.startswith("-") and arg != "-":
            name, value = arg[:2], arg[2:]
            attached = value
        else:
            endpoint = arg if endpoint is None else endpoint
            continue
        if not attached and name in GH_VALUE_OPTIONS:
            value = args[i] if i < len(args) else ""
            i += 1
        if name in ("-X", "--method"):
            method = value
        elif name in ("-f", "-F", "--field", "--raw-field"):
            fields.append((name, value))
    if (method or "").upper() == "PUT" and endpoint and PR_MERGE_PATH.search(endpoint.split("?", 1)[0]):
        return MERGE
    if endpoint == "graphql":
        for flag, value in fields:
            query = re.sub(r"#[^\n]*", "", graphql_query(flag, value, cwd))
            if re.match(r"\s*mutation\b", query) and MERGE_MUTATION.search(query):
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
        cwd = str(payload.get("cwd") or os.getcwd())
        try:
            for args in shell_commands(str(data.get("command", ""))):
                name, rest = program(args)
                reason = git_reason(rest) if name == "git" else gh_reason(rest, cwd) if name == "gh" else None
                if reason:
                    return reason
        except Unclear:
            return UNCLEAR
        except ValueError:
            return UNPARSABLE
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
