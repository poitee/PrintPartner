"""Fail if pp-domain's normal dependency tree includes runtime/IO crates."""

import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

FORBIDDEN = {
    "tokio",
    "rusqlite",
    "sqlx",
    "libsqlite3-sys",
    "hyper",
    "axum",
    "reqwest",
    "tower",
}

# cargo tree --prefix none lines look like: "serde v1.0.228" or "syn v2.0.119 (*)"
PACKAGE_LINE = re.compile(r"^([A-Za-z0-9_-]+)\s+v\d+")


def package_names(tree_output):
    names = set()
    for line in tree_output.splitlines():
        match = PACKAGE_LINE.match(line.strip())
        if match:
            names.add(match.group(1))
    return names


def forbidden_hits(names):
    return sorted(names & FORBIDDEN)


def cargo_tree(manifest, cargo):
    return subprocess.check_output(
        [
            cargo,
            "tree",
            "-p",
            "pp-domain",
            "-e",
            "normal",
            "--prefix",
            "none",
            "--manifest-path",
            str(manifest),
        ],
        text=True,
    )


manifest = Path(__file__).resolve().parents[1] / "Cargo.toml"
cargo = shutil.which("cargo")
if cargo is None:
    raise SystemExit("cargo not found in PATH")

tree = cargo_tree(manifest, cargo)
hits = forbidden_hits(package_names(tree))
if hits:
    raise SystemExit(f"pp-domain must stay free of {', '.join(sorted(FORBIDDEN))}; found: {', '.join(hits)}")

if "--self-test" in sys.argv:
    planted = "\n".join(
        [
            "pp-domain v0.1.0 (/tmp/pp-domain)",
            "serde v1.0.228",
            "tokio v1.40.0",
            "hyper v1.4.1",
            "tower-service v0.3.3",
            "some-crate v0.1.0",
        ]
    )
    planted_hits = forbidden_hits(package_names(planted))
    assert planted_hits == ["hyper", "tokio"], planted_hits
    assert "tower" not in planted_hits  # tower-service must not false-positive as tower
    assert forbidden_hits(package_names("pp-domain v0.1.0\nserde v1.0.228\n")) == []

print(
    json.dumps(
        {
            "pp_domain_tree_lines": len(
                [line for line in tree.splitlines() if PACKAGE_LINE.match(line.strip())]
            ),
            "forbidden_absent": True,
            "intentional_violation_rejected": "--self-test" in sys.argv,
        }
    )
)
