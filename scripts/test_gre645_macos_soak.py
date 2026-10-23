"""Exercise gre645_macos_soak.sh without dispatching hosted macos-26 runs."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).with_name("gre645_macos_soak.sh")


class FakeGh:
    """Minimal gh stub: dry-run never reaches workflow run; execute can succeed or fail."""

    def __init__(self, path: Path, *, fail_at: int | None = None) -> None:
        self.path = path
        self.fail_at = fail_at
        self.state_path = path.with_suffix(".state")
        self.state_path.write_text("0\n", encoding="utf-8")
        fail_at_value = fail_at if fail_at is not None else 0
        self.path.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail
state_file={self.state_path!s}
fail_at={fail_at_value}
cmd="${{1:-}}"
case "$cmd" in
  workflow)
    if [[ "${{2:-}}" != "run" ]]; then echo "unexpected: $*" >&2; exit 90; fi
    n=$(cat "$state_file")
    n=$((n + 1))
    printf '%s\\n' "$n" >"$state_file"
    ;;
  run)
    sub="${{2:-}}"
    if [[ "$sub" == "list" ]]; then
      n=$(cat "$state_file")
      if [[ "$n" -eq 0 ]]; then
        printf '%s\\n' '[]'
      else
        printf '%s\\n' "[{{\\"databaseId\\":$n}}]"
      fi
      exit 0
    fi
    if [[ "$sub" == "view" ]]; then
      run_id="${{3:-}}"
      conclusion=success
      if [[ "$fail_at" -gt 0 && "$run_id" -eq "$fail_at" ]]; then
        conclusion=failure
      fi
      cat <<JSON
{{"url":"https://example.test/actions/runs/$run_id","headSha":"deadbeef$run_id","jobs":[{{"name":"rust (macos)","url":"https://example.test/jobs/$run_id","status":"completed","conclusion":"$conclusion"}}]}}
JSON
      exit 0
    fi
    echo "unexpected run subcommand: $*" >&2
    exit 91
    ;;
  *)
    echo "unexpected gh: $*" >&2
    exit 92
    ;;
esac
""",
            encoding="utf-8",
        )
        self.path.chmod(self.path.stat().st_mode | stat.S_IXUSR)

    @property
    def dispatches(self) -> int:
        return int(self.state_path.read_text(encoding="utf-8").strip())


class Gre645SoakTests(unittest.TestCase):
    def run_script(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        merged = os.environ.copy()
        if env:
            merged.update(env)
        merged["GRE645_POLL_SECONDS"] = "0"
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            cwd=ROOT,
            env=merged,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_dry_run_default_never_dispatches(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeGh(Path(tmp) / "gh")
            out = Path(tmp) / "evidence.jsonl"
            result = self.run_script(
                "main",
                "20",
                str(out),
                env={"GRE645_GH": str(fake.path)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Dry-run only", result.stdout)
            self.assertIn("mode=dry-run", result.stdout)
            self.assertEqual(fake.dispatches, 0)
            self.assertFalse(out.exists())

    def test_execute_records_consecutive_job_links(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeGh(Path(tmp) / "gh")
            out = Path(tmp) / "evidence.jsonl"
            result = self.run_script(
                "--execute",
                "main",
                "3",
                str(out),
                env={"GRE645_GH": str(fake.path)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(fake.dispatches, 3)
            lines = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(lines), 3)
            self.assertEqual(lines[0]["i"], 1)
            self.assertEqual(lines[0]["run"], "https://example.test/actions/runs/1")
            self.assertEqual(lines[0]["job"], "https://example.test/jobs/1")
            self.assertEqual(lines[0]["conclusion"], "success")
            self.assertEqual(lines[2]["sha"], "deadbeef3")

    def test_execute_stops_on_first_red(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeGh(Path(tmp) / "gh", fail_at=2)
            out = Path(tmp) / "evidence.jsonl"
            result = self.run_script(
                "--execute",
                "main",
                "5",
                str(out),
                env={"GRE645_GH": str(fake.path)},
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("streak broken at 2/5", result.stderr)
            self.assertEqual(fake.dispatches, 2)
            lines = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]["i"], 1)
            self.assertEqual(lines[0]["conclusion"], "success")


if __name__ == "__main__":
    unittest.main()
