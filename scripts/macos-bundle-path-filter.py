#!/usr/bin/env python3
"""Select macOS bundle inputs; unknown/missing diff bases always build."""

import os
from pathlib import Path, PurePosixPath
import re
import subprocess


def is_native_input(path):
    parts = PurePosixPath(path).parts
    name = parts[-1]
    # Markdown in web source trees can be packaged runtime data.
    source_markdown = path.startswith("web/") and "src" in parts
    # These exclusions apply inside app/package trees as well as at the root.
    if (path.startswith("docs/") or (name.endswith(".md") and not source_markdown)
            or "fixtures" in parts or "test-fixtures" in parts
            or (path.startswith("web/") and any(p in {"test", "tests", "__tests__"} for p in parts))
            or re.search(r"\.(test|spec)\.", name)):
        return False
    if re.match(r"(?:\.?eslint|\.?prettier|\.?actionlint)(?:[.-]|rc(?:\.|$))", name):
        return False
    if (path == "scripts/check-github-actions-pinned.sh"
            or path.startswith(("scripts/lint-", "web/scripts/lint-"))
            or re.match(r"\.github/workflows/(?:lint(?:[.-]|$)|.*-lint[.-]|actionlint[.-]|pr-evidence(?:-tests)?\.)", path)):
        return False
    # Broad web/Rust trees include source, build configuration and lockfiles.
    # Ancillary evidence data under scripts/ (as in #194) is not a build input.
    return (path.startswith(("rust/", "web/", ".github/actions/", ".github/workflows/"))
            or (path.startswith("scripts/") and name.endswith((".sh", ".py", ".mjs", ".js", ".ts")))
            or name in {"rust-toolchain.toml", "Cargo.toml", "Cargo.lock", "Dockerfile",
                        "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
                        "bun.lock", "bun.lockb"})


# Pull requests only pay for hosted macOS when macOS/desktop-native inputs
# change. Everything else (web, server, generic Rust) is covered by the Linux
# jobs on the PR and by the full macOS run on push to main and nightly.
MACOS_PR_PREFIXES = (
    "rust/crates/pp-desktop/", "rust/crates/pp-compat/",
    "rust/crates/pp-source/", "rust/crates/pp-storage/",
    "rust/scripts/desktop-bundle.sh", "rust/scripts/stage-desktop.py",
    "rust/scripts/assemble-macos-resources.py", "rust/scripts/check-macos-bundle.py",
    "rust/scripts/macos_addon_slices.py", "rust/scripts/build-desktop-manifest.py",
    "rust/scripts/precompress-spa.py",
    "rust/scripts/native-sdk.sh", "rust/scripts/native-process-probe.py",
    "rust/scripts/workflow-smoke", "rust/tests/built_backend_listeners.py",
    ".github/workflows/desktop-native-macos.yml",
    "scripts/macos-bundle-path-filter.py", "scripts/test_macos_bundle_path_filter.py",
)
MACOS_PR_FILES = {"rust-toolchain.toml", "rust/Cargo.lock", "rust/Cargo.toml",
                  "web/package-lock.json", "web/package.json"}


def is_macos_pr_input(path):
    """Narrow PR filter: macOS/desktop-native paths and native dependency locks."""
    if not is_native_input(path):
        return False
    lowered = path.lower()
    return (path.startswith(MACOS_PR_PREFIXES) or path in MACOS_PR_FILES
            or "macos" in lowered or "darwin" in lowered or "tauri" in lowered)


def select_native(event, base, head):
    if event == "workflow_dispatch" or not re.fullmatch(r"[0-9a-f]{40}", base):
        return True
    if subprocess.run(["git", "cat-file", "-e", f"{base}^{{commit}}"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        return True
    # PRs compare from the merge base to the actual head, not the synthetic
    # merge commit: base-branch changes must not turn a fixtures-only PR on.
    revision = f"{base}...{head}" if event == "pull_request" else base
    command = ["git", "diff", "--name-only", "--no-renames", "-z", revision]
    if event != "pull_request":
        command.append(head)
    paths = subprocess.check_output(command).decode("utf-8", errors="surrogateescape").split("\0")
    selector = is_macos_pr_input if event == "pull_request" else is_native_input
    return any(selector(path) for path in paths if path)


if __name__ == "__main__":
    native = select_native(os.environ["EVENT_NAME"], os.environ["BASE_SHA"],
                           os.environ.get("HEAD_SHA") or os.environ["GITHUB_SHA"])
    value = str(native).lower()
    summary = f"Native inputs changed: {value}\n"
    print(summary, end="")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as output:
        output.write(summary)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"native={value}\n")
