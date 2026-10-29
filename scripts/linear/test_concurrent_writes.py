"""GRE-749 controlled interleavings of concurrent Linear writers.

Each runner is a separate copy of pr_status_sync.py, as separate workflow runs are.
They share one fake Linear workspace and one fake GitHub repository. A pause runs
another writer to completion at a chosen request of the paused runner. The fake
Linear has no issue history, so no test depends on it.
"""
import copy
import datetime as dt
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

from test_pr_status_sync import github, pr, ticket


class ConcurrentWriteTest(unittest.TestCase):
    def setUp(self):
        self.issues = {"GRE-1": ticket()}
        self.comments = []  # read by older diagnostics; the sync posts no comments
        self.github = []
        self.queries = []
        self.writes = []
        self.pauses = []
        for target in ("urllib.request.urlopen", "subprocess.check_output"):
            guard = patch(target, side_effect=AssertionError("Unexpected external API call"))
            guard.start()
            self.addCleanup(guard.stop)
        output = patch("builtins.print")
        output.start()
        self.addCleanup(output.stop)

    def runner(self, name, prs=None):
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("pr_status_sync.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.STALE_HOURS = 48
        module._prs = copy.deepcopy(prs)
        module.gql = lambda query, variables: self.linear(name, query, variables)
        module.gh = github(lambda: self.github)
        return module

    def pause(self, runner, marker, callback, skip=0):
        self.pauses.append([runner, marker, skip, callback])

    def linear(self, runner, query, variables):
        self.queries.append((runner, query))
        for pause in self.pauses:
            if pause[0] == runner and pause[1] in query:
                if pause[2]:
                    pause[2] -= 1
                else:
                    self.pauses.remove(pause)
                    pause[3]()
                break
        if "issues(first:1," in query:
            issue = self.issues.get(f"{variables['k']}-{variables['n']}")
            return {"issues": {"nodes": [copy.deepcopy(issue)] if issue else []}}
        if "teams(" in query:
            return {"teams": {"nodes": [{"states": {"nodes": [
                {"id": name, "name": name} for name in ("Backlog", "In Progress", "In Review", "Done")
            ]}}]}}
        if "issueUpdate(" in query:
            self.issues[f"GRE-{variables['id']}"].update(state={
                "name": variables["s"], "type": "completed" if variables["s"] == "Done" else "started"},
                updatedAt=(dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=len(self.writes) + 1)).isoformat())
            self.writes.append((runner, variables["s"]))
            return {"issueUpdate": {"success": True}}
        if "issues(first:250," in query:
            return {"issues": {"nodes": copy.deepcopy([
                issue for issue in self.issues.values() if issue["state"]["name"] in {"In Progress", "In Review"}
            ]), "pageInfo": {"hasNextPage": False, "endCursor": None}}}
        raise AssertionError(f"Unexpected fake query: {query}")

    def state(self, ident="GRE-1"):
        return self.issues[ident]["state"]["name"]

    def assert_no_comments(self):
        self.assertEqual([q for _, q in self.queries if "comment" in q.lower()], [])

    def test_shared_issue_open_write_after_done_is_reverted(self):
        opened = pr(number=1)
        merged = pr(number=2, state="MERGED", body="Fixes GRE-1")
        self.github = [opened, merged]
        event, other = self.runner("event"), self.runner("other")
        self.pause("event", "issueUpdate(", lambda: other.apply_event(merged, {"action": "closed"}))
        event.apply_event(opened, {"action": "opened"})
        self.assertEqual(self.pauses, [])
        self.assertEqual(self.writes, [("other", "Done"), ("event", "In Review"), ("event", "Done")])
        self.assertEqual(self.state(), "Done")

    def test_stale_write_after_two_other_writes_restores_done(self):
        opened = pr(number=10)
        merged = pr(number=11, state="MERGED", body="Fixes GRE-1")
        reconcile, event, merge = self.runner("reconcile"), self.runner("event"), self.runner("merge")
        def open_then_merge():
            self.github.append(opened)
            event.apply_event(opened, {"action": "opened"})
            self.github.append(merged)
            merge.apply_event(merged, {"action": "closed"})
        self.pause("reconcile", "issueUpdate(", open_then_merge)
        reconcile.reconcile(3)
        self.assertEqual(self.pauses, [])
        self.assertEqual(self.writes, [("event", "In Review"), ("merge", "Done"),
                                       ("reconcile", "Backlog"), ("reconcile", "Done")])
        self.assertEqual(self.state(), "Done")

    def test_replayed_open_write_after_done_is_reverted(self):
        opened = pr(number=1)
        merged = pr(number=2, state="MERGED", body="Fixes GRE-1")
        self.github = [opened, merged]
        event, other = self.runner("event"), self.runner("other")
        send = event.gql
        def lost_response(query, variables):
            # gql replays issueUpdate when the response is lost; the merge lands in between.
            if "issueUpdate(" in query and not self.writes:
                send(query, variables)
                other.apply_event(merged, {"action": "closed"})
            return send(query, variables)
        event.gql = lost_response
        event.apply_event(opened, {"action": "opened"})
        self.assertEqual(self.writes, [("event", "In Review"), ("other", "Done"),
                                       ("event", "In Review"), ("event", "Done")])
        self.assertEqual(self.state(), "Done")

    def test_shared_issue_done_before_guard_read_rejects_open_write(self):
        opened = pr(number=1)
        merged = pr(number=2, state="MERGED", body="Fixes GRE-1")
        self.github = [opened, merged]
        event, other = self.runner("event"), self.runner("other")
        self.pause("event", "issues(first:1,", lambda: other.apply_event(merged, {"action": "closed"}), skip=1)
        event.apply_event(opened, {"action": "opened"})
        self.assertEqual(self.pauses, [])
        self.assertEqual(self.writes, [("other", "Done")])
        self.assertEqual(self.state(), "Done")

    def test_stale_reconcile_backlog_write_is_reverted(self):
        opened = pr()
        reconcile, event = self.runner("reconcile"), self.runner("event")
        def open_pr():
            self.github.append(opened)
            event.apply_event(opened, {"action": "opened"})
        self.pause("reconcile", "issueUpdate(", open_pr)
        reconcile.reconcile(3)
        self.assertEqual(self.pauses, [])
        self.assertEqual(self.writes, [("event", "In Review"), ("reconcile", "Backlog"),
                                       ("reconcile", "In Review")])
        self.assertEqual(self.state(), "In Review")
        self.assert_no_comments()

    def test_stale_backlog_write_over_silent_open_event_is_reverted(self):
        self.issues["GRE-1"] = ticket(state="In Review")
        opened = pr()
        reconcile, event = self.runner("reconcile"), self.runner("event")
        def open_pr():
            # The issue is already In Review, so this run writes nothing to Linear.
            self.github.append(opened)
            event.apply_event(opened, {"action": "opened"})
        self.pause("reconcile", "issueUpdate(", open_pr)
        reconcile.reconcile(3)
        self.assertEqual(self.pauses, [])
        self.assertEqual(self.writes, [("reconcile", "Backlog"), ("reconcile", "In Review")])
        self.assertEqual(self.state(), "In Review")

    def test_slice_merge_over_silent_open_event_is_reverted(self):
        self.issues["GRE-1"] = ticket(state="In Review")
        merged = pr(state="MERGED")
        self.github = [merged]
        merge, event = self.runner("merge"), self.runner("event")
        second = pr(number=2)
        def open_second():
            self.github.append(second)
            event.apply_event(second, {"action": "opened"})
        # The merge run decided In Progress from a snapshot without PR 2.
        self.pause("merge", "issues(first:1,", open_second, skip=1)
        merge.apply_event(merged, {"action": "closed"})
        self.assertEqual(self.pauses, [])
        self.assertEqual(self.writes, [("merge", "In Progress"), ("merge", "In Review")])
        self.assertEqual(self.state(), "In Review")

    def test_stale_reconcile_listing_rejects_backlog_write(self):
        opened = pr()
        reconcile, event = self.runner("reconcile"), self.runner("event")
        def open_pr():
            self.github.append(opened)
            event.apply_event(opened, {"action": "opened"})
        self.pause("reconcile", "issues(first:1,", open_pr)
        reconcile.reconcile(3)
        self.assertEqual(self.pauses, [])
        self.assertEqual(self.writes, [("event", "In Review")])
        self.assertEqual(self.state(), "In Review")

    def test_event_and_reconcile_overlap_without_comments(self):
        opened = pr()
        self.github = [opened]
        event, reconcile = self.runner("event"), self.runner("reconcile")
        self.pause("event", "issueUpdate(", lambda: reconcile.reconcile(3))
        event.apply_event(opened, {"action": "opened"})
        self.assertEqual(self.pauses, [])
        self.assertEqual(self.writes, [("reconcile", "In Review"), ("event", "In Review")])
        self.assertEqual(self.state(), "In Review")
        self.assert_no_comments()

    def test_unrelated_issue_event_completes_while_first_is_paused(self):
        self.issues["GRE-2"] = ticket(2)
        first_pr = pr()
        second_pr = pr(number=2, body="Refs GRE-2")
        first, second = self.runner("first"), self.runner("second")
        self.pause("first", "issueUpdate(", lambda: second.apply_event(second_pr, {"action": "opened"}))
        first.apply_event(first_pr, {"action": "opened"})
        self.assertEqual(self.pauses, [])
        self.assertEqual(self.writes, [("second", "In Review"), ("first", "In Review")])
        self.assertEqual([self.state(key) for key in ("GRE-1", "GRE-2")], ["In Review", "In Review"])


if __name__ == "__main__":
    unittest.main()
