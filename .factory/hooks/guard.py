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
from urllib.parse import urlsplit

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
REPO_PATH = r"(?:^|/)repos/[^/]+/[^/]+/"
# (methods, endpoint path, reason) for REST requests that bypass review or release rules.
REST_RULES = (
    ({"PUT"}, re.compile(REPO_PATH + r"pulls/\d+/merge$"), MERGE),
    ({"POST"}, re.compile(REPO_PATH + r"merges$"), MERGE),
    ({"POST"}, re.compile(REPO_PATH + r"releases$"), RELEASE),
    ({"PATCH", "DELETE"}, re.compile(REPO_PATH + r"git/refs/heads/main$"), MAIN),
    ({"PATCH", "DELETE"}, re.compile(REPO_PATH + r"git/refs/tags/.+$"), RELEASE),
)
GIT_REFS = re.compile(REPO_PATH + r"git/refs$")
CONTENTS = re.compile(REPO_PATH + r"contents/.+$")
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


def closing_double_quote(source, i):
    while i < len(source):
        char = source[i]
        if char == "\\":
            i += 2
        elif char == '"':
            return i
        elif source.startswith("$(", i):
            i = closing_paren(source, i + 2) + 1
        elif char == "`":
            i = closing_backtick(source, i + 1) + 1
        else:
            i += 1
    raise ValueError("unterminated quote")


def closing_paren(source, i):
    depth = 1
    while i < len(source):
        char = source[i]
        if char == "\\":
            i += 2
            continue
        if char == "'":
            end = source.find("'", i + 1)
            if end < 0:
                raise ValueError("unterminated quote")
            i = end + 1
            continue
        if char == '"':
            i = closing_double_quote(source, i + 1) + 1
            continue
        depth += {"(": 1, ")": -1}.get(char, 0)
        if depth == 0:
            return i
        i += 1
    raise ValueError("unterminated command substitution")


def closing_backtick(source, i):
    while i < len(source):
        if source[i] == "\\":
            i += 2
        elif source[i] == "`":
            return i
        else:
            i += 1
    raise ValueError("unterminated command substitution")


def substitutions(text):
    """Return command substitutions in text where quotes are literal, such as a heredoc body."""
    found, i = [], 0
    while i < len(text):
        if text[i] == "\\":
            i += 2
        elif text.startswith("$(", i):
            end = closing_paren(text, i + 2)
            found.append(text[i + 2:end])
            i = end + 1
        elif text[i] == "`":
            end = closing_backtick(text, i + 1)
            found.append(text[i + 1:end])
            i = end + 1
        else:
            i += 1
    return found


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
                raw = match.group(1)
                delimiter = HEREDOC_QUOTING.sub(lambda m: m.group(1) or "", raw)
                heredocs.append((delimiter, tabs, not any(c in raw for c in "'\"\\")))
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
                for delimiter, tabs, expands in heredocs:
                    body = []
                    while i < len(source):
                        end = source.find("\n", i)
                        end = len(source) if end < 0 else end
                        line = source[i:end].rstrip("\r")
                        i = end + 1
                        if (line.lstrip("\t") if tabs else line) == delimiter:
                            break
                        body.append(line)
                    if expands:
                        nested.extend(substitutions("\n".join(body)))
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
    dry_run = False
    for kind, arg in parsed:
        if kind == "long" and arg in ("--dry-run", "--no-dry-run"):
            dry_run = arg == "--dry-run"
        elif kind == "short" and "n" in arg:
            dry_run = True
    if dry_run:
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
        option, value = args[i], args[i + 1] if i + 1 < len(args) else ""
        if option.startswith("--config-env="):
            value = option.split("=", 1)[1]
        if option in ("-c", "--config-env") or option.startswith("--config-env="):
            if value.lower().startswith("core.hookspath"):
                return HOOKS
        i += 2 if option in GIT_VALUE_OPTIONS else 1
    if i >= len(args):
        return None
    command, rest = args[i], args[i + 1:]
    if command == "config":
        positional = [arg for kind, arg in options(rest) if kind == "arg"]
        if len(positional) >= 2 and positional[0].lower() == "core.hookspath":
            return HOOKS
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


def read_input(name, cwd):
    """Read a file gh will send, or refuse when the hook cannot see it."""
    path = Path(name)
    if name == "-" or not path.is_absolute() and cwd is None:
        raise Unclear
    try:
        return (Path(cwd or "/") / path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        raise Unclear from None


def graphql_query(flag, value, cwd):
    key, _, text = value.partition("=")
    if key != "query":
        return ""
    if flag in ("-F", "--field") and text.startswith("@"):
        return read_input(text[1:], cwd)
    return text


def without_graphql_comments(document):
    out, i = [], 0
    while i < len(document):
        if document.startswith('"""', i):
            end = document.find('"""', i + 3)
            end = len(document) if end < 0 else end + 3
        elif document[i] == '"':
            end = i + 1
            while end < len(document) and document[end] not in '"\n':
                end += 2 if document[end] == "\\" else 1
            end += 1
        elif document[i] == "#":
            newline = document.find("\n", i)
            i = len(document) if newline < 0 else newline
            continue
        else:
            end = i + 1
        out.append(document[i:end])
        i = end
    return "".join(out)


def graphql_documents(fields, body, cwd):
    documents = [graphql_query(flag, value, cwd) for flag, value in fields]
    if body is not None:
        text = read_input(body, cwd)
        try:
            decoded = json.loads(text)
        except ValueError:
            decoded = None
        if isinstance(decoded, (dict, list)):
            items = decoded if isinstance(decoded, list) else [decoded]
            text = "\n".join(str(item.get("query", "")) for item in items if isinstance(item, dict))
        documents.append(text)
    return [without_graphql_comments(document) for document in documents]


def without_repo_flags(args):
    kept, i = [], 0
    while i < len(args):
        arg = args[i]
        if arg in ("-R", "--repo"):
            i += 2
            continue
        if not (arg.startswith("--repo=") or arg.startswith("-R") and len(arg) > 2):
            kept.append(arg)
        i += 1
    return kept


def gh_reason(args, cwd):
    args = without_repo_flags(args)
    if args[:1] == ["help"]:
        return None
    if args[:2] in (["pr", "merge"], ["release", "create"]):
        if args[2:] and all(arg in ("--help", "-h") for arg in args[2:]):
            return None
        return MERGE if args[0] == "pr" else RELEASE
    if args[:1] != ["api"]:
        return None
    method, endpoint, fields, body, i = None, None, [], None, 1
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
        elif name == "--input":
            body = value
    if endpoint is None:
        return None
    # gh sends POST when the request has fields or a body.
    method = (method or ("POST" if fields or body is not None else "GET")).upper()
    path = urlsplit(endpoint).path.strip("/")
    values = dict(value.partition("=")[::2] for _, value in fields)
    for methods, pattern, reason in REST_RULES:
        if method in methods and pattern.search(path):
            return reason
    if method == "POST" and GIT_REFS.search(path):
        ref = values.get("ref", "")
        if ref.startswith("refs/tags/"):
            return RELEASE
        if MAIN_REF.match(ref):
            return MAIN
    if method == "PUT" and CONTENTS.search(path) and values.get("branch", "main") == "main":
        return MAIN
    if path == "graphql" or path.endswith("/graphql"):
        for document in graphql_documents(fields, body, cwd):
            if re.search(r"\bmutation\b", document) and MERGE_MUTATION.search(document):
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
                if name in ("cd", "pushd", "popd"):
                    targets = [arg for arg in rest if not arg.startswith("-")]
                    plain = name != "popd" and len(targets) == 1 and not re.search(r"[$~`]", targets[0])
                    cwd = os.path.normpath(os.path.join(cwd, targets[0])) if plain and cwd else None
                    continue
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
