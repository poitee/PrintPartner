"""GRE-749 diagnostics of missing removed-reference provenance.

Run explicitly with python3 -B scripts/linear/reproduce_reference_recovery.py -v.
Keep current limitations outside ordinary test_*.py discovery. Deleted history
below is a modeled allowed history deletion, not a live GitHub API fixture.
No GitHub diff format or history completeness is assumed.
"""
import copy
import unittest
from unittest.mock import patch

import test_concurrent_writes as fake
from test_pr_status_sync import pr, ticket


REMOVED = [{"issueId": "1", "body":
            "[pr-status-sync] PR #1 removed its reference; no other open PR."}]


class ReferenceRecoveryReproduction(unittest.TestCase):
    def setUp(self):
        self.store = fake.ConcurrentWriteTest()
        self.addCleanup(self.store.doCleanups)
        self.store.setUp()
        for target in ("socket.socket", "subprocess.Popen", "os.system"):
            guard = patch(target, side_effect=AssertionError("Unexpected external I/O"))
            guard.start()
            self.addCleanup(guard.stop)
        self.current = pr(body="Current description without a ticket.")
        self.recent_issue = ticket(state="In Review", age=1)

    def history(self, previous_body, others=()):
        self.store.issues = {"GRE-1": copy.deepcopy(self.recent_issue)}
        self.store.comments = []
        self.store.writes = []
        previous = dict(self.current, body=previous_body)
        runner = self.store.runner("history", [previous, *others])
        runner.apply_event(previous, {"action": "opened"})
        self.assertEqual(previous["title"], self.current["title"])
        self.assertEqual(previous["headRefName"], "slice")
        self.assertEqual(self.store.comments, [])
        self.assertEqual(self.store.writes, [])
        runner._prs = copy.deepcopy([self.current, *others])
        event = {"action": "edited", "changes": {"body": {"from": previous_body}}}
        return runner, event

    def assert_outcome(self, state, comments, writes):
        self.assertEqual(self.store.issues["GRE-1"]["state"]["name"], state)
        self.assertEqual(self.store.comments, comments)
        self.assertEqual(self.store.writes, writes)

    def deleted_history_observation(self, runner):
        """Model unavailable revision content with equal surviving metadata.

        These are evidence categories, not a GraphQL response. Neither title
        changes nor readable old body content survive in this modeled case.
        """
        return copy.deepcopy({
            "current_prs": runner.all_prs(),
            "title_renames": [],
            "body_edits": [{"edited_at": self.current["updatedAt"],
                            "editor": "same-editor", "content_deleted": True,
                            "available_content": None}],
            "linear_issue": self.store.issues["GRE-1"],
            "linear_comments": self.store.comments,
        })

    def test_open_body_reference_already_in_review_leaves_no_ledger(self):
        runner, _ = self.history("Refs GRE-1")
        self.assertEqual(runner.refs(dict(self.current, body="Refs GRE-1")),
                         (set(), {"GRE-1"}))
        self.assertEqual(runner.refs(self.current), (set(), set()))
        self.assert_outcome("In Review", [], [])

    def test_retained_previous_body_event_recovers_exact_removal_explanation(self):
        runner, event = self.history("Refs GRE-1")
        runner.apply_event(self.current, event)
        self.assert_outcome("In Progress", REMOVED, [("history", "In Progress")])

    def test_reconcile_replacing_pending_removal_loses_state_and_explanation(self):
        outcomes = []
        for retain_event in (True, False):
            runner, pending_removal = self.history("Refs GRE-1")
            if retain_event:
                runner.apply_event(self.current, pending_removal)
                self.assert_outcome("In Progress", REMOVED, [("history", "In Progress")])
            else:
                # Model pending-job replacement by executing only its successor.
                runner.reconcile(3)
                self.assert_outcome("In Review", [], [])
            outcomes.append(copy.deepcopy((self.store.issues, self.store.comments)))
        self.assertNotEqual(*outcomes)

    def test_deleted_body_histories_are_indistinguishable_but_need_different_removals(self):
        observations = []
        outcomes = []
        for old_body, state, comments, writes in (
            ("Refs GRE-1", "In Progress", REMOVED, [("history", "In Progress")]),
            ("Earlier description without a ticket.", "In Review", [], []),
        ):
            runner, retained_oracle_event = self.history(old_body)
            observation = self.deleted_history_observation(runner)
            self.assertEqual(observation["title_renames"], [])
            self.assertIsNone(observation["body_edits"][0]["available_content"])
            observations.append(observation)
            runner.reconcile(3)
            self.assert_outcome("In Review", [], [])
            # The retained event is an oracle, unavailable to history recovery.
            runner.apply_event(self.current, retained_oracle_event)
            self.assert_outcome(state, comments, writes)
            outcomes.append(copy.deepcopy((self.store.issues, self.store.comments)))
        self.assertEqual(*observations)
        self.assertNotEqual(*outcomes)

    def test_another_current_open_pr_preserves_in_review_after_removal(self):
        runner, event = self.history("Refs GRE-1", others=[pr(number=2)])
        runner.apply_event(self.current, event)
        runner.reconcile(3)
        self.assert_outcome("In Review", [], [])

    def test_manually_in_review_without_past_reference_must_not_move(self):
        runner, event = self.history("Earlier description without a ticket.")
        runner.apply_event(self.current, event)
        runner.reconcile(3)
        self.assert_outcome("In Review", [], [])


if __name__ == "__main__":
    unittest.main()
