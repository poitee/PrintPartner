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
import subprocess
import sys
from urllib.parse import urlsplit

MERGE = "Merging is the maintainer's job. Report readiness instead."
FORCE = "Never force-push. Add a commit instead."
MAIN = "Push a branch and open a PR; main only changes by merge."
RELEASE = "Releases and tags need separate authorization."
HOOKS = "Do not bypass Git hooks."
UNCLEAR = "Cannot classify this git or gh command; run it without the wrapper option."
UNPARSABLE = "Cannot parse shell command; use a simpler command."
EXPANSION = "Cannot classify a shell expansion here; write git and gh arguments literally."

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
MAIN_REF = re.compile(r"^(?:(?:refs/)?heads/)?main$")
PUSH_VALUE_LONG = {"--exec", "--push-option", "--receive-pack", "--repo"}
COMMIT_VALUE_LONG = {"--author", "--date", "--file", "--message", "--reedit-message",
                     "--reuse-message", "--template", "--trailer"}
GH_SHORT_BOOLEAN = set("ih")
RELEASE_READS = {"download", "list", "verify", "verify-asset", "view"}
# Git commands that can change which branch HEAD names before a later push runs.
BRANCH_CHANGES = {"bisect", "branch", "checkout", "rebase", "switch", "symbolic-ref", "worktree"}
# Marks text the shell expands at run time, so its value is unknown here.
EXPANDED = "\x00"
GH_VALUE_OPTIONS = {"-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq",
                    "-t", "--template", "--hostname", "-p", "--preview", "--cache", "-X", "--method"}
GH_SHORT_VALUE = {option[1] for option in GH_VALUE_OPTIONS if len(option) == 2}
# Wrapper options that run the program in another directory.
WRAPPER_CHDIR = {"-C", "--chdir", "-D"}
REPO_PATH = r"(?:^|/)repos/[^/]+/[^/]+/"
# The only REST writes agents may make through gh api: PR and issue comments.
COMMENT_WRITES = re.compile(REPO_PATH + r"(?:issues/\d+/comments|pulls/\d+/comments(?:/\d+/replies)?"
                            r"|issues/comments/\d+|pulls/comments/\d+)$")
ALLOWED_MUTATIONS = {"addComment", "addPullRequestReviewComment", "addPullRequestReviewThreadReply",
                     "resolveReviewThread", "unresolveReviewThread", "updateIssueComment",
                     "updatePullRequestReviewComment"}
# GraphQL ends comments at CR or LF, and a block string may contain an escaped \""".
GRAPHQL_TOKEN = re.compile(r'"""(?:\\"""|[^"]|"(?!""))*"""|"(?:\\.|[^"\\\n\r])*"|#[^\n\r]*|\.\.\.|[A-Za-z_]\w*|\S')
API_WRITE = ("Through gh api, agents may read and write PR or issue comments and review threads; "
             "other writes need the maintainer.")
SAFE_PUSH_LONG = {"--atomic", "--dry-run", "--force-if-includes", "--ipv4", "--ipv6", "--no-atomic",
                  "--no-dry-run", "--no-force-if-includes", "--no-progress", "--no-signed", "--no-thin",
                  "--porcelain", "--progress", "--push-option", "--quiet", "--repo", "--set-upstream",
                  "--signed", "--thin", "--verbose"}
SAFE_PUSH_SHORT = set("46noquv")
PUSH_OPTIONS = "Use common git push options spelled in full."
PUSH_EXPLICIT = "Name the destination branch, for example `git push origin HEAD:topic`."
CONFIG_READ_OPTIONS = {"--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"}
CONFIG_READ_COMMANDS = {"get", "list"}
# Environment assignments that point git at another repository.
GIT_LOCATION = re.compile(r"^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=")
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
ANSI_C_QUOTE = re.compile(r"\$'((?:\\.|[^'\\])*)'", re.S)


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


def skip_heredoc_bodies(source, i, pending):
    """Return the index after the bodies of pending heredocs that start at i."""
    for delimiter, tabs in pending:
        while i < len(source):
            end = source.find("\n", i)
            end = len(source) if end < 0 else end
            line = source[i:end].rstrip("\r")
            i = end + 1
            if (line.lstrip("\t") if tabs else line) == delimiter:
                break
    return i


def closing_paren(source, i):
    depth, pending = 1, []
    while i < len(source):
        char = source[i]
        if char == "\\":
            i += 2
            continue
        # Heredoc bodies inside a substitution are data; their quotes and parentheses do not count.
        if source.startswith("<<", i) and not source.startswith("<<<", i):
            tabs = source.startswith("-", i + 2)
            match = HEREDOC.match(source, i + 2 + tabs)
            if match:
                pending.append((HEREDOC_QUOTING.sub(lambda m: m.group(1) or "", match.group(1)), tabs))
                i = match.end()
                continue
        if char == "\n" and pending:
            i = skip_heredoc_bodies(source, i + 1, pending)
            pending = []
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
    """Split shell source into (arguments, in_subshell, after_and_or) for simple commands.

    Handles quotes, escapes, continuations, separators, comments, redirections,
    heredoc bodies, and command substitutions. It does not evaluate expansions.
    """
    commands, args, word, heredocs, nested = [], [], None, [], []
    drop_next = piped = after_logic = False
    depth = 0

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
                    text.append(EXPANDED)
                    j = end + 1
                elif c == "`":
                    end = closing_backtick(source, j + 1)
                    nested.append(source[j + 1:end])
                    text.append(EXPANDED)
                    j = end + 1
                else:
                    text.append(EXPANDED + c if c == "$" else c)
                    j += 1
            word = (word or "") + "".join(text)
            i = j + 1
        elif source.startswith("$'", i):
            match = ANSI_C_QUOTE.match(source, i)
            if not match:
                raise ValueError("unterminated quote")
            word = (word or "") + match.group(1).encode("latin-1", "backslashreplace").decode("unicode_escape")
            i = match.end()
        elif source.startswith("$(", i):
            end = closing_paren(source, i + 2)
            nested.append(source[i + 2:end])
            word = (word or "") + EXPANDED
            i = end + 1
        elif char == "`":
            end = closing_backtick(source, i + 1)
            nested.append(source[i + 1:end])
            word = (word or "") + EXPANDED
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
                # A pipeline stage or background job runs in its own subshell.
                pipe = char in "|&" and source[i + 1:i + 2] != char and source[i - 1:i] != char
                # A command after && or || may not run.
                logic = char in "|&" and not pipe
                inside = depth > 0
                depth += {"(": 1, ")": -1}.get(char, 0)
                if args:
                    commands.append((args, inside or pipe or piped, after_logic))
                    args = []
                piped, after_logic = pipe, logic
            i += 1
            if char == "\n":
                for delimiter, tabs, expands in heredocs:
                    body = []
                    while i < len(source):
                        end = source.find("\n", i)
                        end = len(source) if end < 0 else end
                        line = source[i:end].rstrip("\r")
                        i = end + 1
                        # Bash joins backslash-newline in an unquoted heredoc before matching the delimiter.
                        while expands and (len(line) - len(line.rstrip("\\"))) % 2 and i < len(source):
                            end = source.find("\n", i)
                            end = len(source) if end < 0 else end
                            line = line[:-1] + source[i:end].rstrip("\r")
                            i = end + 1
                        if (line.lstrip("\t") if tabs else line) == delimiter:
                            break
                        body.append(line)
                    if expands:
                        nested.extend(substitutions("\n".join(body)))
                heredocs = []
        else:
            word = (word or "") + (EXPANDED + char if char == "$" else char)
            i += 1
    finish_word()
    if args:
        commands.append((args, depth > 0 or piped, after_logic))
    for inner in nested:
        commands.extend((inner_args, True, conditional) for inner_args, _, conditional in shell_commands(inner))
    return commands


def program(args):
    """Return the executed program name, its arguments, and whether a wrapper changed directory."""
    i, moved = 0, False
    while i < len(args):
        word = args[i]
        if ASSIGNMENT.match(word) or word in SHELL_PREFIXES:
            moved = moved or bool(GIT_LOCATION.match(word))
            i += 1
            continue
        name = PurePosixPath(word).name
        if name not in WRAPPERS:
            return name, args[i + 1:], moved
        i += 1
        while i < len(args) and args[i].startswith("-"):
            option = args[i]
            if option == "--":
                i += 1
                break
            if name == "env" and (option.startswith("--split-string") or re.match(r"^-[^-]*S", option)):
                raise Unclear
            moved = moved or option.split("=", 1)[0] in WRAPPER_CHDIR or bool(re.match(r"^-[^-]*[CD]", option))
            i += 2 if option in WRAPPERS[name] else 1
        i += WRAPPER_OPERANDS.get(name, 0)
    return None, [], moved


def options(args, value_flags="", stop_flags="", value_long=()):
    """Yield ("long" | "short" | "arg", text) for one command's arguments.

    A short bundle stops at a flag that takes a value; when that value is the
    next argument, it is skipped rather than read as another option.
    """
    i, ended = 0, False
    while i < len(args):
        arg = args[i]
        i += 1
        if not ended and arg.startswith(EXPANDED):
            raise Unclear(EXPANSION)
        if not ended and arg == "--":
            ended = True
        elif ended or arg == "-" or not arg.startswith("-"):
            yield "arg", arg
        elif arg.startswith("--"):
            name = arg.split("=", 1)[0]
            if EXPANDED in name:
                raise Unclear(EXPANSION)
            yield "long", name
            if arg in value_long:
                i += 1
        else:
            flags = ""
            for char in arg[1:]:
                flags += char
                if char in value_flags or char in stop_flags:
                    break
            if EXPANDED in flags:
                raise Unclear(EXPANSION)
            yield "short", flags
            if flags[-1:] in tuple(value_flags) and len(flags) == len(arg) - 1:
                i += 1


def skips_hooks(option):
    """Return whether a long option is --no-verify or a prefix Git could expand to it."""
    return len(option) > 2 and "--no-verify".startswith(option)


def current_branch(cwd, location):
    """Return the checked-out branch, using only the location options of the git command."""
    if cwd is None or any(EXPANDED in arg for arg in location):
        return None
    try:
        result = subprocess.run(["git", *location, "symbolic-ref", "--quiet", "--short", "HEAD"],
                                cwd=cwd, capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def push_reason(args, cwd, location, head_moves):
    parsed = list(options(args, value_flags="o", value_long=PUSH_VALUE_LONG))
    dry_run = False
    for kind, arg in parsed:
        if kind == "long" and arg in ("--dry-run", "--no-dry-run"):
            dry_run = arg == "--dry-run"
        elif kind == "short" and "n" in arg:
            dry_run = True
    if dry_run:
        return None
    longs = [arg for kind, arg in parsed if kind == "long"]
    shorts = "".join(arg for kind, arg in parsed if kind == "short")
    if "--no-verify" in longs:
        return HOOKS
    if {"--force", "--force-with-lease", "--mirror"} & set(longs) or "f" in shorts:
        return FORCE
    if {"--tags", "--follow-tags"} & set(longs):
        return RELEASE
    if set(longs) - SAFE_PUSH_LONG or set(shorts) - SAFE_PUSH_SHORT:
        return PUSH_OPTIONS
    positional = [arg for kind, arg in parsed if kind == "arg"]
    refspecs = positional if "--repo" in longs else positional[1:]
    if not refspecs:
        return PUSH_EXPLICIT
    for refspec in refspecs:
        if refspec.startswith("+"):
            return FORCE
        if refspec == "tag" or "refs/tags/" in refspec:
            return RELEASE
        # ":" alone pushes every matching branch; braces and globs expand to other refs.
        if EXPANDED in refspec or set(refspec) & set("*?[{}"):
            return PUSH_EXPLICIT
        destination = refspec.rsplit(":", 1)[-1]
        if not destination:
            return PUSH_EXPLICIT
        if destination in ("HEAD", "@"):
            destination = None if head_moves else current_branch(cwd, location)
            if destination is None:
                return PUSH_EXPLICIT
        if MAIN_REF.match(destination):
            return MAIN
    return None


def git_command(args):
    """Return the subcommand index, location options, and any -c hook override reason."""
    i, location, reason = 0, [], None
    while i < len(args) and args[i].startswith("-"):
        option, value = args[i], args[i + 1] if i + 1 < len(args) else ""
        if option.startswith("--config-env="):
            value = option.split("=", 1)[1]
        if option in ("-c", "--config-env") or option.startswith("--config-env="):
            if EXPANDED in value:
                raise Unclear(EXPANSION)
            if value.lower().startswith("core.hookspath"):
                reason = HOOKS
        if EXPANDED in option.split("=", 1)[0]:
            raise Unclear(EXPANSION)
        if option in ("-C", "--git-dir", "--work-tree"):
            location += [option, value]
        elif option.startswith(("--git-dir=", "--work-tree=")):
            location.append(option)
        i += 2 if option in GIT_VALUE_OPTIONS else 1
    if i < len(args) and EXPANDED in args[i]:
        raise Unclear(EXPANSION)
    return i, location, reason


def moves_head(name, args):
    if name == "git":
        i = git_command(args)[0]
        return i < len(args) and args[i] in BRANCH_CHANGES
    return name == "gh" and without_repo_flags(args)[:2] == ["pr", "checkout"]


def git_reason(args, cwd, head_moves=False):
    i, location, reason = git_command(args)
    if reason or i >= len(args):
        return reason
    command, rest = args[i], args[i + 1:]
    if command == "push":
        return push_reason(rest, cwd, location, head_moves)
    if command == "config":
        # Read operations are options or the first operand; a value such as "get" is not one.
        operands = [arg for arg in rest if not arg.startswith("-")]
        reads = ({arg.split("=", 1)[0] for arg in rest if arg.startswith("-")} & CONFIG_READ_OPTIONS
                 or operands[:1] and operands[0] in CONFIG_READ_COMMANDS)
        if any(arg.lower() == "core.hookspath" for arg in rest) and not reads:
            return HOOKS
    if command == "commit":
        parsed = options(rest, value_flags="mFcCt", stop_flags="uS", value_long=COMMIT_VALUE_LONG)
        if any(kind == "long" and skips_hooks(arg) or kind == "short" and "n" in arg
               for kind, arg in parsed):
            return HOOKS
    elif command in HOOK_COMMANDS:
        if any(kind == "long" and skips_hooks(arg) for kind, arg in options(rest)):
            return HOOKS
    return None

def read_input(name, cwd):
    """Read a file gh will send, or refuse when the hook cannot see it."""
    path = Path(name)
    if name == "-" or EXPANDED in name or not path.is_absolute() and cwd is None:
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


def mutation_fields(document):
    """Return the root fields of every mutation in a GraphQL document.

    Returns None when a mutation's root selection uses a fragment, because the
    fields it adds are not visible here.
    """
    tokens = [token for token in GRAPHQL_TOKEN.findall(document)
              if token != "," and not token.startswith(("#", '"'))]
    fields, i, parens = [], 0, 0
    while i < len(tokens):
        # Variable definitions and directive arguments may hold "{" or a $mutation name.
        parens += {"(": 1, ")": -1}.get(tokens[i], 0)
        if not parens and tokens[i] in ("query", "subscription", "fragment"):
            # Skip the operation or fragment name, which may itself be "mutation".
            i += 2 if re.match(r"[A-Za-z_]", tokens[i + 1] if i + 1 < len(tokens) else "") else 1
            continue
        if parens or tokens[i] not in ("mutation", "{"):
            i += 1
            continue
        mutation = tokens[i] == "mutation"
        while i < len(tokens) and (tokens[i] != "{" or parens):
            parens += {"(": 1, ")": -1}.get(tokens[i], 0)
            i += 1
        depth = parens = 0
        while i < len(tokens):
            token = tokens[i]
            i += 1
            if token == "{":
                depth += 1
            elif token == "}":
                depth -= 1
                if depth == 0:
                    break
            elif token == "(":
                parens += 1
            elif token == ")":
                parens -= 1
            elif mutation and depth == 1 and parens == 0:
                if token == "...":
                    return None
                if token == "@":
                    i += 1
                elif re.match(r"[A-Za-z_]", token) and tokens[i:i + 1] != [":"]:
                    fields.append(token)
    return fields


def graphql_documents(fields, body, cwd):
    documents = [graphql_query(flag, value, cwd) for flag, value in fields]
    if any(EXPANDED in document for document in documents):
        raise Unclear(EXPANSION)
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
    return documents

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
    if any(EXPANDED in arg for arg in args[:2]):
        raise Unclear(EXPANSION)
    if args[:1] == ["help"]:
        return None
    release_write = (args[:1] == ["release"] and args[1:2] and not args[1].startswith("-")
                     and args[1] not in RELEASE_READS)
    if args[:2] == ["pr", "merge"] or release_write:
        if args[2:] and all(arg in ("--help", "-h") for arg in args[2:]):
            return None
        return MERGE if args[0] == "pr" else RELEASE
    if args[:1] != ["api"]:
        return None
    method, endpoint, fields, body, i = None, None, [], None, 1
    while i < len(args):
        arg = args[i]
        i += 1
        if arg.startswith(EXPANDED):
            raise Unclear(EXPANSION)
        if arg.startswith("--"):
            name, attached, value = arg.partition("=")
            if EXPANDED in name:
                raise Unclear(EXPANSION)
        elif arg.startswith("-") and arg != "-":
            name = None
            for j, flag in enumerate(arg[1:], 2):
                if flag in GH_SHORT_VALUE:
                    name, value = "-" + flag, arg[j:]
                    break
                if flag not in GH_SHORT_BOOLEAN:
                    raise Unclear
            if name is None:
                continue
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
            if EXPANDED in value.partition("=")[0]:
                raise Unclear(EXPANSION)
            fields.append((name, value))
        elif name == "--input":
            body = value
    if endpoint is None:
        return None
    # gh sends POST when the request has fields or a body.
    method = (method or ("POST" if fields or body is not None else "GET")).upper()
    if method in ("GET", "HEAD"):
        return None
    path = urlsplit(endpoint).path.strip("/")
    if path == "graphql" or path.endswith("/graphql"):
        for document in graphql_documents(fields, body, cwd):
            names = mutation_fields(document)
            if names is None or set(names) - ALLOWED_MUTATIONS:
                return API_WRITE
        return None
    if method in ("POST", "PATCH") and COMMENT_WRITES.search(path):
        return None
    return API_WRITE


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
            parsed = shell_commands(str(data.get("command", "")))
            commands = [(*program(args), scoped, conditional) for args, scoped, conditional in parsed]
            # Substitutions run out of source order, so any branch change makes HEAD unknown.
            # An exported GIT_DIR or similar can also point a later push at another repository.
            head_moves = (any(moves_head(name, rest) for name, rest, *_ in commands)
                          or any(GIT_LOCATION.match(arg) for args, *_ in parsed for arg in args))
            control = 0
            for (args, *_), (name, rest, moved, scoped, conditional) in zip(parsed, commands):
                control += args[0] in ("if", "while", "until", "for", "case", "select")
                control -= args[0] in ("fi", "done", "esac")
                if name in ("cd", "pushd", "popd"):
                    targets = [arg for arg in rest if not arg.startswith("-")]
                    # A directory change that may be skipped leaves no single directory after it.
                    plain = (name != "popd" and len(targets) == 1 and not (scoped or moved or conditional or control)
                             and not re.search(r"[$~`\x00]", targets[0]))
                    # A directory change inside a subshell has no single directory after it.
                    cwd = os.path.normpath(os.path.join(cwd, targets[0])) if plain and cwd else None
                    continue
                here = None if moved else cwd
                reason = git_reason(rest, here, head_moves) if name == "git" else gh_reason(rest, here) if name == "gh" else None
                if reason:
                    return reason
        except Unclear as error:
            return str(error) or UNCLEAR
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
