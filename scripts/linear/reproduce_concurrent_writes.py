"""GRE-749 diagnostics. Passing tests confirm the races, not their prevention.

Run explicitly with python3 -B scripts/linear/reproduce_concurrent_writes.py -v.
These diagnostics intentionally stay outside test_*.py discovery until a fix
can replace the unsafe outcomes with regression assertions.
"""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

from test_pr_status_sync import pr, ticket


class ConcurrentWriteReproduction(unittest.TestCase):
    def setUp(self):
        self.issues = {"GRE-1": ticket()}
        self.comments = []
        self.writes = []
        self.before = None
        for target in ("urllib.request.urlopen", "subprocess.check_output"):
            guard = patch(target, side_effect=AssertionError("Unexpected external API call"))
            guard.start()
            self.addCleanup(guard.stop)
        output = patch("builtins.print")
        output.start()
        self.addCleanup(output.stop)

    def runner(self, name, prs):
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("pr_status_sync.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module._prs = copy.deepcopy(prs)
        module.gql = lambda query, variables: self.linear(name, query, variables)
        return module

    def linear(self, runner, query, variables):
        if self.before and runner == self.before[0] and self.before[1] in query:
            callback = self.before[2]
            self.before = None
            callback()
        if "issues(first:1," in query:
            issue = self.issues.get(f"{variables['k']}-{variables['n']}")
            return {"issues": {"nodes": [copy.deepcopy(issue)] if issue else []}}
        if "teams(" in query:
            return {"teams": {"nodes": [{"states": {"nodes": [
                {"id": name, "name": name} for name in ("Backlog", "In Progress", "In Review", "Done")
            ]}}]}}
        if "comments(first:" in query:
            return {"issue": {"comments": {
                "nodes": copy.deepcopy([c for c in self.comments if c["issueId"] == variables["id"]]),
                "pageInfo": {"hasNextPage": False, "endCursor": None}}}}
        if "commentCreate(" in query:
            self.comments.append({"issueId": variables["id"], "body": variables["b"]})
            return {"commentCreate": {"success": True}}
        if "issueUpdate(" in query:
            self.issues[f"GRE-{variables['id']}"]["state"] = {
                "name": variables["s"], "type": "completed" if variables["s"] == "Done" else "started"}
            self.writes.append((runner, variables["s"]))
            return {"issueUpdate": {"success": True}}
        if "issues(first:250," in query:
            return {"issues": {"nodes": copy.deepcopy([
                issue for issue in self.issues.values() if issue["state"]["name"] in {"In Progress", "In Review"}
            ]), "pageInfo": {"hasNextPage": False, "endCursor": None}}}
        raise AssertionError(f"Unexpected fake query: {query}")

    def test_shared_issue_open_event_overwrites_done(self):
        opened = pr(number=1)
        merged = pr(number=2, state="MERGED", body="Fixes GRE-1")
        event = self.runner("event", [opened])
        other = self.runner("other", [merged])
        self.before = ("event", "issueUpdate(", lambda: other.apply_event(merged, {"action": "closed"}))
        event.apply_event(opened, {"action": "opened"})
        self.assertIsNone(self.before)
        self.assertEqual(self.writes, [("other", "Done"), ("event", "In Review")])
        self.assertEqual(self.issues["GRE-1"]["state"]["name"], "In Review")

    def test_stale_reconcile_sweep_overwrites_open_event(self):
        opened = pr()
        reconcile = self.runner("reconcile", [])
        event = self.runner("event", [opened])
        self.before = ("reconcile", "issueUpdate(", lambda: event.apply_event(opened, {"action": "opened"}))
        reconcile.reconcile(3)
        self.assertIsNone(self.before)
        self.assertEqual(self.writes, [("event", "In Review"), ("reconcile", "Backlog")])
        self.assertEqual(self.issues["GRE-1"]["state"]["name"], "Backlog")

    def test_event_and_reconcile_create_duplicate_comments(self):
        opened = pr()
        event = self.runner("event", [opened])
        reconcile = self.runner("reconcile", [opened])
        self.before = ("event", "commentCreate(", lambda: reconcile.reconcile(3))
        event.apply_event(opened, {"action": "opened"})
        self.assertIsNone(self.before)
        self.assertEqual(self.comments, [
            {"issueId": "1", "body": "[pr-status-sync] PR #1 open: A slice"},
            {"issueId": "1", "body": "[pr-status-sync] PR #1 open: A slice"},
        ])
        self.assertEqual(self.issues["GRE-1"]["state"]["name"], "In Review")

    def test_unrelated_issue_event_completes_while_first_is_paused(self):
        self.issues["GRE-2"] = ticket(2)
        first_pr = pr()
        second_pr = pr(number=2, body="Refs GRE-2")
        first = self.runner("first", [first_pr])
        second = self.runner("second", [second_pr])
        self.before = ("first", "issueUpdate(", lambda: second.apply_event(second_pr, {"action": "opened"}))
        first.apply_event(first_pr, {"action": "opened"})
        self.assertIsNone(self.before)
        self.assertEqual(self.writes, [("second", "In Review"), ("first", "In Review")])
        self.assertEqual([self.issues[key]["state"]["name"] for key in ("GRE-1", "GRE-2")],
                         ["In Review", "In Review"])


if __name__ == "__main__":
    unittest.main()
