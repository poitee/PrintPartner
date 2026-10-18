#!/usr/bin/env python3
"""Migrate tuple claim patterns while retaining each claim's Source lease."""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "crates/pp-storage"
paths = [root / "src/jobs.rs", root / "src/bin/jobs-fixture.rs"]
paths += sorted((root / "tests").glob("*.rs"))
for path in paths:
    source = path.read_text()
    # The RHS must call claim, not another API that happens to return a tuple.
    source, count = re.subn(
        r"\blet \(([^()\n]+), ([^()\n]+)\)(\s*=\s*[^;]*?\.claim(?:_kind|_import)?\([^;]*?;)",
        lambda m: "let claimed_attempt!(" + m[1] + ", " + m[2] + ")" + m[3],
        source,
    )
    source, outcomes = re.subn(
        r"(?<=let )Outcome::Claimed\(Some\(\(([^()]+), ([^()]+)\)\)\)",
        r"Outcome::Claimed(Some(claimed_attempt!(\1, \2)))",
        source,
    )
    replacements = {
        "let (_, mut lease) = claims.pop().unwrap();":
            "let claimed_attempt!(_, mut lease) = claims.pop().unwrap();",
        'let (claimed, _lease) = if command == "concurrent"':
            'let claimed_attempt!(claimed, _lease) = if command == "concurrent"',
        "let mut lease = worker.claim().unwrap().unwrap().1;":
            "let claimed_attempt!(_, mut lease) = worker.claim().unwrap().unwrap();",
    }
    extra = 0
    for before, after in replacements.items():
        extra += source.count(before)
        source = source.replace(before, after)
    if not count + outcomes + extra:
        continue
    if "/src/claimed_attempt.rs" not in source:
        scope = "    " if path.name == "jobs.rs" else ""
        include = scope + 'include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/claimed_attempt.rs"));\n'
        if path.name == "jobs.rs":
            source = source.replace("mod tests {\n", "mod tests {\n" + include, 1)
        else:
            anchor = "use anyhow::" if "use anyhow::" in source else "use pp_storage::"
            source = source.replace(anchor, include + anchor, 1)
    if path.name != "jobs.rs" and "jobs::*" not in source:
        source = source.replace(
            "use pp_storage::{",
            "use pp_storage::jobs::ClaimedAttempt;\nuse pp_storage::{",
            1,
        )
    path.write_text(source)
    print(f"{path.relative_to(root)}: {count + outcomes + extra} patterns")
