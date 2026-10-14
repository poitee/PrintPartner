#!/usr/bin/env python3
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PINS = {
    "landed": "1beaa1cc09622611505b6470402027053db10d91",
    "reference": "d73b6d8d250b84e22b37262a0c2720d4f777a0ca",
    "audited": "2e3cac927a1a82cf2d1a276f9564772f6cd67ee4",
}
SOURCE = "rust/crates/pp-source/"
FILES = tuple(SOURCE + path for path in (
    "src/media.rs", "src/bin/pp-source-media.rs", "tests/media.rs",
    "tests/direct_model_binding.rs", "tests/support/process.rs", "src/archive.rs",
))
ADDITIONS = {SOURCE + path for path in (
    "tests/direct_model_binding.rs", "tests/support/process.rs",
)}
PROBES = "rust/tests/source-media/"
RESIDUALS = (SOURCE + "src/media.rs", PROBES + "verify-zip64.py")
ENV = dict(os.environ, LC_ALL="C", GIT_NO_REPLACE_OBJECTS="1",
           GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_ATTR_NOSYSTEM="1",
           GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)


def git(*args, optional=False):
    result = subprocess.run(
        ["git", "--no-pager", "-C", str(ROOT), "-c", "core.quotePath=true",
         "-c", "core.attributesFile=" + os.devnull,
         "-c", "diff.suppressBlankEmpty=false", *args],
        env=ENV, capture_output=True, text=True, encoding="utf-8",
    )
    if result.returncode and not optional:
        raise RuntimeError(f"Git command failed ({' '.join(args)}): {result.stderr.strip()}")
    return None if result.returncode else result.stdout


def require(path, pin, expected, observed):
    if observed != expected:
        raise ValueError(f"{path} at {pin}: expected {expected!r}, observed {observed!r}")


def main():
    missing = [f"{name} {pin}" for name, pin in PINS.items()
               if git("cat-file", "-e", pin + "^{commit}", optional=True) is None]
    if missing:
        raise RuntimeError("Missing historical objects: " + ", ".join(missing)
                           + ". Fetch history containing these full commit IDs before rerunning."
                           + " This audit does not fetch.")
    trees = {
        name: set(git("ls-tree", "-r", "--name-only", pin, "--", PROBES).splitlines())
        for name, pin in PINS.items()
    }
    require(PROBES, PINS["landed"], "nonempty probe inventory", "nonempty probe inventory"
            if trees["landed"] else "empty probe inventory")
    for name in ("reference", "audited"):
        require(PROBES, PINS[name], sorted(trees["landed"]), sorted(trees[name]))
    rows = [f"{name} {pin}" for name, pin in PINS.items()]
    for path in sorted(set(FILES).union(*trees.values())):
        blobs = {name: git("rev-parse", "--verify", pin + ":" + path, optional=True)
                 for name, pin in PINS.items()}
        blobs = {name: blob.strip() if blob is not None else None
                 for name, blob in blobs.items()}
        if blobs["landed"] is None:
            require(path, PINS["landed"], "existing blob", None)
        require(path, PINS["audited"], blobs["landed"], blobs["audited"])
        if path in ADDITIONS:
            require(path, PINS["reference"], None, blobs["reference"])
            delta = "absent (intentional #131 addition)"
        elif path == SOURCE + "src/archive.rs":
            require(path, PINS["audited"], "e09d653c7733a17fd98d9316e52886a42bb33c7d",
                    blobs["audited"])
            delta = "outside D4 classification (#131 dependency)"
        elif path in RESIDUALS:
            if blobs["reference"] is None or blobs["reference"] == blobs["audited"]:
                require(path, PINS["reference"], "existing, different blob", blobs["reference"])
            delta = "diff " + blobs["reference"] + " -> " + blobs["audited"]
        else:
            require(path, PINS["reference"], blobs["landed"], blobs["reference"])
            delta = "equal " + blobs["reference"]
        rows.append(f"{path}: audited = landed {blobs['audited']}; reference {delta}")
    pin = PINS["audited"]
    lib = git("show", pin + ":" + SOURCE + "src/lib.rs")
    prefix = "mod acl;\npub mod archive;\nmod directory;\npub mod media;\n"
    require(SOURCE + "src/lib.rs", pin, prefix, lib[:len(prefix)])
    cargo = git("show", pin + ":" + SOURCE + "Cargo.toml")
    features = re.search(r"(?ms)^\[features\]\n(.*?)(?=^\[|\Z)", cargo)
    observed = features.group(1).strip() if features else None
    require(SOURCE + "Cargo.toml [features]", pin,
            "default = []\ndesktop_rebuild = []", observed)
    rows.append("audited gates: pub mod media is unconditional; default = []; desktop_rebuild = []")
    diffs = []
    for path in RESIDUALS:
        diff = git("diff", "--no-ext-diff", "--no-textconv", "--diff-algorithm=myers",
                   "--text", "--no-color", "--word-diff=none", "--no-renames",
                   "--no-indent-heuristic", "--full-index",
                   "--unified=3", "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/",
                   "--no-relative",
                   "--ignore-submodules=none", PINS["reference"], pin, "--", path)
        if not diff:
            require(path, pin, "nonempty reference diff", diff)
        diffs.append(diff)
    print("\n".join(rows) + "\n\n" + "\n".join(diffs), end="")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 1:
            raise RuntimeError("Usage: python3 rust/scripts/audit-d4-media.py (no arguments)")
        main()
    except ValueError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    except (OSError, RuntimeError) as error:
        print(error, file=sys.stderr)
        sys.exit(2)
