"""Run seven single-edit mutants against the public working-draft client tests."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

rust = Path(__file__).resolve().parents[4]
source = Path("crates/pp-storage/src/working_drafts.rs")
diff = source.with_suffix("") / "diff.rs"
mutants = [
    ("workspace skips origin validation", source, "                    draft_origin(&draft.header)?;", ""),
    ("list ignores creation time", source, "ORDER BY created_at,id", "ORDER BY id"),
    ("diff ignores revision ID", diff, 'profile["acceptedPlanRevisionId"] == d.header["baseRevisionId"]\n                    && ', ""),
    ("diff ignores Plan version", diff, '\n                    && profile["acceptedPlanVersion"] == d.header["basePlanVersion"]', ""),
    ("diff drops changed fields", diff, '.filter(|f| !before.same_field(after, f))', '.filter(|_| false)'),
    ("diff sorts added IDs numerically", diff, 'added.sort_by(|a, b| js_cmp(&a["id"], &b["id"]));', 'added.sort_by_key(|part| part["id"].as_i64());'),
    ("diff ignores manifest requirement", diff, '.filter(|f| !before.same_field(after, f))', '.filter(|f| **f != "requirement" && !before.same_field(after, f))'),
]
with tempfile.TemporaryDirectory(prefix="pp-working-draft-mutants-") as directory:
    scratch = Path(directory) / "rust"
    shutil.copytree(rust, scratch, ignore=shutil.ignore_patterns("target"))
    env = {**os.environ, "CARGO_TARGET_DIR": str(rust / "target")}
    command = ["cargo", "nextest", "run", "--locked", "--manifest-path", str(scratch / "Cargo.toml"), "-p", "pp-storage", "--features", "desktop_rebuild", "--test", "working_draft_core", "--test-threads=2"]
    baseline = subprocess.run(command, env=env, capture_output=True, text=True)
    if baseline.returncode:
        raise SystemExit(baseline.stdout + baseline.stderr)
    killed = 0
    for name, path, before, after in mutants:
        target = scratch / path
        original = target.read_text()
        if original.count(before) != 1:
            raise SystemExit(f"Mutation target is not unique: {name}")
        try:
            target.write_text(original.replace(before, after))
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            output = result.stdout + result.stderr
            if result.returncode == 100 and "FAIL [" in output:
                killed += 1
                print(f"KILLED {name}", flush=True)
            elif result.returncode == 0:
                print(f"SURVIVED {name}", flush=True)
            else:
                raise SystemExit(output)
        finally:
            target.write_text(original)
    print(f"{killed}/{len(mutants)} mutants killed")
    if killed != len(mutants):
        raise SystemExit(1)
