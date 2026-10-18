#!/usr/bin/env python3
"""Prove the rebase budget tests reject missing charges and eager row decoding."""

import pathlib
import signal
import subprocess


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "rust/crates/pp-storage/src/working_drafts/rebase.rs"
COMMAND = [
    "cargo", "test", "--manifest-path", str(ROOT / "rust/Cargo.toml"),
    "-p", "pp-storage", "--features", "desktop_rebuild", "--lib",
    "working_drafts::rebase::budget_tests", "--", "--nocapture",
]


def run():
    result = subprocess.run(COMMAND, cwd=ROOT, capture_output=True, text=True, timeout=300)
    output = result.stdout + result.stderr
    print(output, end="", flush=True)
    return result.returncode, output


def stop(signum, _frame):
    raise SystemExit(128 + signum)


def main():
    original = SOURCE.read_text()
    code, _ = run()
    if code:
        raise SystemExit("baseline tests must pass before running mutants")
    eager_before = """    let mut query = statement.query(params![tenant, revision])?;
    let mut parts = Vec::new();
    while let Some(row) = query.next()? {
        budget.visit(0)?;
        parts.push(Accepted {
            id: row.get(0)?,
            projection: row.get(1)?,
            included: json!(row.get::<_, i64>(2)? != 0),
            quantity_override: json!(row.get::<_, Option<i64>>(3)?),
        });
    }
"""
    eager_after = """    let parts = statement.query_map(params![tenant, revision], |row| {
        Ok(Accepted {
            id: row.get(0)?,
            projection: row.get(1)?,
            included: json!(row.get::<_, i64>(2)? != 0),
            quantity_override: json!(row.get::<_, Option<i64>>(3)?),
        })
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    for _ in &parts {
        budget.visit(0)?;
    }
"""
    mutants = [
        ("uncharged ambiguity", "                budget.comparison(candidates.len())?;", ""),
        ("uncharged accepted rows", "        budget.visit(0)?;\n        parts.push(Accepted {", "        parts.push(Accepted {"),
        ("eager accepted decoding", eager_before, eager_after),
    ]
    previous_handler = signal.signal(signal.SIGTERM, stop)
    try:
        for name, before, after in mutants:
            if original.count(before) != 1:
                raise SystemExit(f"{name}: mutation target must occur exactly once")
            SOURCE.write_text(original.replace(before, after, 1))
            print(f"Testing mutant: {name}", flush=True)
            code, output = run()
            if code == 0 or "test result: FAILED" not in output:
                raise SystemExit(f"{name}: expected a test assertion failure")
            print(f"KILLED: {name}", flush=True)
            SOURCE.write_text(original)
    finally:
        SOURCE.write_text(original)
        signal.signal(signal.SIGTERM, previous_handler)
    code, _ = run()
    if code:
        raise SystemExit("restored baseline failed")


if __name__ == "__main__":
    main()
