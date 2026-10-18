import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
EVENT = json.loads((ROOT / "scripts/fixtures/merge_group/checks_requested.json").read_text())


class MergeGroupWorkflowTests(unittest.TestCase):
    def test_required_workflows_accept_merge_group_fixture(self):
        for filename in ("actionlint.yml", "rust-cross-os.yml", "desktop-native-macos.yml"):
            with self.subTest(workflow=filename):
                workflow = yaml.load(
                    (ROOT / ".github/workflows" / filename).read_text(), Loader=yaml.BaseLoader
                )
                self.assertEqual(workflow["on"].get("merge_group"), {"types": [EVENT["action"]]})

    def test_required_lint_and_rust_jobs_use_the_filter(self):
        for filename, kind, contexts in (
            ("actionlint.yml", "actions", {"actionlint": "actionlint", "zizmor": "zizmor"}),
            ("rust-cross-os.yml", "rust", {"rust-linux": "rust (linux)",
                                           "rust-windows": "rust (windows)"}),
        ):
            with self.subTest(workflow=filename):
                workflow = yaml.load(
                    (ROOT / ".github/workflows" / filename).read_text(), Loader=yaml.BaseLoader
                )
                jobs = workflow["jobs"]
                select = next(step for step in jobs["changes"]["steps"]
                              if step.get("id") == "select")
                self.assertIn(f"python3 scripts/ci-path-filter.py {kind}", select["run"].splitlines())
                self.assertEqual(select["env"], {
                    "EVENT_NAME": "${{ github.event_name }}",
                    "BASE_SHA": "${{ github.event.pull_request.base.sha }}",
                    "HEAD_SHA": "${{ github.event.pull_request.head.sha }}",
                })
                self.assertEqual(jobs["changes"]["outputs"]["relevant"],
                                 "${{ steps.select.outputs.relevant }}")
                for job_id, context in contexts.items():
                    job = jobs[job_id]
                    self.assertEqual(job.get("name", job_id), context)
                    self.assertEqual(job["needs"], "changes")
                    self.assertEqual(job["if"], "${{ !cancelled() && "
                                     "(needs.changes.result != 'success' || "
                                     "needs.changes.outputs.relevant != 'false') }}")
                    checkout = next(step for step in job["steps"]
                                    if step.get("uses", "").startswith("actions/checkout@"))
                    self.assertNotIn("ref", checkout.get("with", {}))

    def test_merge_group_runs_filters_even_for_docs_only_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=directory, text=True).strip()

            git("init", "-q")
            git("config", "user.name", "Merge group fixture")
            git("config", "user.email", "fixture@example.com")
            readme = directory / "README.md"
            readme.write_text("base\n")
            git("add", "README.md")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            readme.write_text("docs-only update\n")
            git("commit", "-qam", "docs")
            head = git("rev-parse", "HEAD")
            event = {**EVENT, "merge_group": {**EVENT["merge_group"],
                                             "base_sha": base, "head_sha": head}}
            event_path = directory / "event.json"
            event_path.write_text(json.dumps(event))
            pull_request = event.get("pull_request", {})
            for kind in ("actions", "rust"):
                for event_name, base_sha, head_sha, expected in (
                    ("pull_request", base, head, "false"),
                    ("merge_group", pull_request.get("base", {}).get("sha", ""),
                     pull_request.get("head", {}).get("sha", ""), "true"),
                    ("merge_group", event["merge_group"]["base_sha"],
                     event["merge_group"]["head_sha"], "true"),
                ):
                    with self.subTest(kind=kind, event=event_name, base=base_sha):
                        output = directory / "output"
                        summary = directory / "summary"
                        output.write_text("")
                        summary.write_text("")
                        result = subprocess.run(
                            [sys.executable, str(ROOT / "scripts/ci-path-filter.py"), kind],
                            cwd=directory, text=True, capture_output=True, check=True,
                            env={**os.environ, "EVENT_NAME": event_name, "BASE_SHA": base_sha,
                                 "HEAD_SHA": head_sha, "GITHUB_EVENT_PATH": str(event_path),
                                 "GITHUB_SHA": head, "GITHUB_REF": event["merge_group"]["head_ref"],
                                 "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)},
                        )
                        self.assertEqual(output.read_text(), f"relevant={expected}\n")
                        self.assertEqual(result.stdout, f"{kind} inputs changed: {expected}\n")
                        self.assertEqual(summary.read_text(), result.stdout)


if __name__ == "__main__":
    unittest.main()
