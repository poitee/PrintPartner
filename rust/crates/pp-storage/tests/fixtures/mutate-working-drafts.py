"""Run single-edit mutants against the public working-draft client tests."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

rust = Path(__file__).resolve().parents[4]
source = Path("crates/pp-storage/src/working_drafts.rs")
diff = source.with_suffix("") / "diff.rs"
mutants = [
    ("workspace skips origin validation", source, "            draft_origin(&draft.header)?;\n", ""),
    ("list ignores creation time", source, "SELECT id,state,lifecycle_version,snapshot_digest,base_revision_id,base_plan_version FROM plan_drafts WHERE tenant_id=? AND profile_id=? ORDER BY created_at,id", "SELECT id,state,lifecycle_version,snapshot_digest,base_revision_id,base_plan_version FROM plan_drafts WHERE tenant_id=? AND profile_id=? ORDER BY id"),
    ("diff ignores revision ID", diff, 'profile["acceptedPlanRevisionId"] == d.header["baseRevisionId"]\n                    && ', ""),
    ("diff ignores Plan version", diff, '\n                    && profile["acceptedPlanVersion"] == d.header["basePlanVersion"]', ""),
    ("diff drops changed fields", diff, '.filter(|f| !before.same_field(after, f))', '.filter(|_| false)'),
    ("diff sorts added IDs numerically", diff, 'added.sort_by(|a, b| js_cmp(&a["id"], &b["id"]));', 'added.sort_by_key(|part| part["id"].as_i64());'),
    ("diff sorts removed IDs numerically", diff, 'removed.sort_by(|a, b| js_cmp(&a["id"], &b["id"]));', 'removed.sort_by_key(|part| part["id"].as_i64());'),
    ("diff sorts changed IDs numerically", diff, 'changed.sort_by(|a, b| js_cmp(&a.after["id"], &b.after["id"]));', 'changed.sort_by_key(|part| part.after["id"].as_i64());'),
    ("diff ignores manifest requirement", diff, '.filter(|f| !before.same_field(after, f))', '.filter(|f| **f != "requirement" && !before.same_field(after, f))'),
    ("edit accepts a stale digest", source, 'if current.header["snapshotDigest"] != expected {', "if false {"),
    ("edit keeps the prior selection", source, "current_required_unit_reconciliation_id=NULL,snapshot_digest=?", "snapshot_digest=?"),
    ("edit keeps the selection digest format", source, "model::selection(&planning, None)", "planning"),
    ("edit resets to the effective quantity", source, "COALESCE(?1,quantity_inferred)", "COALESCE(?1,quantity_effective)"),
    ("edit model resets to the effective quantity", source, 'None => part["quantityInferred"].clone(),', 'None => part["quantityEffective"].clone(),'),
    ("edit skips automatic selection", source, "if selected.selected.is_some() {", "if true {"),
    ("unchanged edit checks the digest", source, "let selected = if parts == current.parts {", "let selected = if false {"),
    ("edit allows a closed draft", source, 'if current.header["state"] != "open" {', "if false {"),
    ("baseline ignores existing Parts", source, "version != 0\n            || one(", "version != 0\n            && one("),
    ("edit base ignores Plan version", source, '|| profile_row["acceptedPlanVersion"] != current.header["basePlanVersion"]', "|| false"),
    ("abandon of consumed is draft_changed", source, "DraftState::Consumed => {\n            return Ok(AbandonOutcome::NotOpen {", "DraftState::Consumed => {\n            return Ok(AbandonOutcome::DraftChanged {"),
    ("abandon retry is not idempotent", source, "DraftState::Abandoned if identity.lifecycle_version == expected + 1 =>", "DraftState::Abandoned if false =>"),
    ("write skips the commit cancellation check", source, "    let outcome = body(&tx)?;\n    ensure!(!cancelled.load(Ordering::Acquire), Failure::Cancelled);", "    let outcome = body(&tx)?;"),
    ("edit allows 10001 decisions", source, "(1..=10_000).contains", "(1..=10_001).contains"),
    ("edit allows an empty Part list", source, "if decision.ids().is_empty()", "if false"),
]
(rust / "target").mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix="pp-working-draft-mutants-", dir=rust / "target") as directory:
    scratch = Path(directory) / "rust"
    shutil.copytree(rust, scratch, ignore=shutil.ignore_patterns("target"))
    (Path(directory) / "web").symlink_to(rust.parent / "web", target_is_directory=True)
    env = {**os.environ, "CARGO_TARGET_DIR": str(Path(directory) / "target")}
    command = ["cargo", "nextest", "run", "--locked", "--manifest-path", str(scratch / "Cargo.toml"), "-p", "pp-storage", "--features", "desktop_rebuild", "--test", "working_draft_core", "--test", "working_draft_writes", "--test-threads=2"]
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
