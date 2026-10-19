import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest
from unittest.mock import patch

from event_inbox import CapacityExceeded, DeliveryConflict, EventInbox
import reproduce_concurrent_writes as fake
from test_pr_status_sync import pr, ticket


class EventInboxTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "inbox.sqlite"
        self.bounds = dict(max_issues_per_event=3, max_pending_per_issue=3,
                           max_pending_total=6, max_payload_bytes=4096)
        for target in ("socket.socket", "urllib.request.urlopen", "subprocess.Popen", "os.system"):
            guard = patch(target, side_effect=AssertionError("Unexpected external I/O"))
            guard.start()
            self.addCleanup(guard.stop)

    def inbox(self, **bounds):
        inbox = EventInbox(self.path, **(self.bounds | bounds))
        self.addCleanup(inbox.close)
        return inbox

    def test_exact_payload_and_order_survive_reopen_and_reads(self):
        inbox = self.inbox()
        payload = b'{ "pr": {"body": "\xc3\xa9"}, "event": {"changes": {"body": {"from": "Refs GRE-1"}}}}'
        self.assertTrue(inbox.enqueue("z-first", payload, ["GRE-1"]))
        inbox.enqueue("a-second", b"second snapshot", ["GRE-1"])
        inbox.close()
        reopened = self.inbox()
        expected = [("z-first", payload), ("a-second", b"second snapshot")]
        self.assertEqual(reopened.pending("GRE-1"), expected)
        rows = reopened.pending("GRE-1")
        rows.clear()
        self.assertEqual(reopened.pending("GRE-1"), expected)
        self.assertEqual(reopened.pending("unknown"), [])

    def test_bounds_are_positive_integers(self):
        for name in self.bounds:
            for invalid in (0, -1, True, 1.5, "2", None):
                with self.subTest(name=name, invalid=invalid):
                    with self.assertRaisesRegex(ValueError, "positive integers"):
                        self.inbox(**{name: invalid})

    def test_connections_must_match_persisted_bounds_even_when_empty(self):
        first = self.inbox()
        first.enqueue("first", b"original", ["GRE-1"])
        second = self.inbox()
        self.assertEqual(second.pending("GRE-1"), [("first", b"original")])
        for name, value in self.bounds.items():
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, "persisted configuration"):
                    self.inbox(**{name: value + 1})
        first.acknowledge("GRE-1", "first")
        first.close()
        second.close()
        with self.assertRaisesRegex(ValueError, "persisted configuration"):
            self.inbox(max_pending_total=100)

    def test_minimum_bounds_accept_exact_capacity(self):
        inbox = self.inbox(**dict.fromkeys(self.bounds, 1))
        self.assertTrue(inbox.enqueue("e", b"x", ["i"]))
        self.assertFalse(inbox.enqueue("e", b"x", ["i"]))
        with self.assertRaises(CapacityExceeded):
            inbox.enqueue("f", b"y", ["j"])
        self.assertEqual(inbox.pending("i"), [("e", b"x")])

    def test_id_formats_and_metadata_lengths_are_bounded(self):
        inbox = self.inbox()
        for invalid in ("", "a" * 129, "white space", "é", "x\n", "/path", ":first", 7, None):
            with self.subTest(event_id=invalid):
                with self.assertRaises(ValueError):
                    inbox.enqueue(invalid, b"x", ["GRE-1"])
        for invalid in ("", "a" * 65, "white space", "é", "x\n", "a.b", "_first", 7, None):
            with self.subTest(issue_id=invalid):
                with self.assertRaises(ValueError):
                    inbox.enqueue("event", b"x", ["GRE-1", invalid])
                with self.assertRaises(ValueError):
                    inbox.pending(invalid)
                with self.assertRaises(ValueError):
                    inbox.acknowledge(invalid, "event")
        self.assertEqual(inbox.pending("GRE-1"), [])
        for invalid in ([], "GRE-1", b"GRE-1"):
            with self.assertRaises(ValueError):
                inbox.enqueue("event", b"x", invalid)
        for invalid in ("mutable", bytearray(b"mutable"), {"pr": {}}):
            with self.assertRaises(TypeError):
                inbox.enqueue("event", invalid, ["GRE-1"])
        inbox.enqueue("a" * 128, b"x", ["b" * 64])
        inbox.enqueue("gh:delivery.1-test_ok", b"y", ["GRE-1", "8f73421a-aaaa-bbbb-cccc-000000000001"])
        self.assertEqual(inbox.pending("b" * 64), [("a" * 128, b"x")])

    def test_payload_limit_counts_bytes_and_does_not_retain_rejected_id(self):
        inbox = self.inbox(max_payload_bytes=4)
        payload = '"é"'.encode()
        self.assertEqual(len(payload), 4)
        with self.assertRaisesRegex(CapacityExceeded, "payload byte"):
            inbox.enqueue("event", payload + b" ", ["GRE-1", "GRE-2"])
        self.assertEqual(inbox.pending("GRE-1"), [])
        self.assertEqual(inbox.pending("GRE-2"), [])
        self.assertTrue(inbox.enqueue("event", payload, ["GRE-2"]))
        self.assertEqual(inbox.pending("GRE-2"), [("event", payload)])

    def test_fanout_overflow_rejects_every_destination(self):
        inbox = self.inbox()
        with self.assertRaisesRegex(CapacityExceeded, "fanout"):
            inbox.enqueue("event", b"rejected", ["GRE-1", "GRE-2", "GRE-3", "GRE-4"])
        for ident in ("GRE-1", "GRE-2", "GRE-3", "GRE-4"):
            self.assertEqual(inbox.pending(ident), [])
        self.assertTrue(inbox.enqueue("event", b"accepted", ["GRE-1", "GRE-2", "GRE-3"]))

    def test_per_issue_overflow_rejects_whole_fanout_without_eviction(self):
        inbox = self.inbox(max_pending_per_issue=1)
        inbox.enqueue("first", b"retained", ["GRE-1"])
        for attempt in range(3):
            with self.assertRaisesRegex(CapacityExceeded, "Per-issue"):
                inbox.enqueue("overflow", b"rejected", ["GRE-2", "GRE-1"])
            self.assertEqual(inbox.pending("GRE-1"), [("first", b"retained")])
            self.assertEqual(inbox.pending("GRE-2"), [])
        self.assertTrue(inbox.enqueue("overflow", b"different", ["GRE-2"]))

    def test_global_overflow_rejects_whole_fanout(self):
        inbox = self.inbox(max_pending_total=3)
        inbox.enqueue("first", b"retained", ["GRE-1"])
        with self.assertRaisesRegex(CapacityExceeded, "Global"):
            inbox.enqueue("overflow", b"rejected", ["GRE-2", "GRE-3", "GRE-4"])
        self.assertEqual(inbox.pending("GRE-1"), [("first", b"retained")])
        for ident in ("GRE-2", "GRE-3", "GRE-4"):
            self.assertEqual(inbox.pending(ident), [])
        inbox.enqueue("overflow", b"accepted", ["GRE-2", "GRE-3"])
        self.assertEqual(inbox.pending("GRE-3"), [("overflow", b"accepted")])

    def test_database_failure_partway_through_fanout_rolls_back_every_row(self):
        inbox = self.inbox()
        with closing(sqlite3.connect(self.path)) as inspection:
            inspection.execute("""CREATE TRIGGER fail_destination BEFORE INSERT ON inbox_pending
                WHEN new.issue_id = 'GRE-2' BEGIN SELECT RAISE(ABORT, 'forced failure'); END""")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "forced failure"):
            inbox.enqueue("event", b"rejected", ["GRE-1", "GRE-2"])
        self.assertEqual(inbox.pending("GRE-1"), [])
        self.assertEqual(inbox.pending("GRE-2"), [])
        with closing(sqlite3.connect(self.path)) as inspection:
            inspection.execute("DROP TRIGGER fail_destination")
            self.assertEqual(inspection.execute("SELECT COUNT(*) FROM inbox_events").fetchone(), (0,))
        self.assertTrue(inbox.enqueue("event", b"retry", ["GRE-1", "GRE-2"]))

    def test_retained_replay_and_conflicts_after_partial_acknowledgement(self):
        inbox = self.inbox(max_pending_total=2)
        inbox.enqueue("event", b"exact bytes", ["GRE-1", "GRE-2"])
        self.assertFalse(inbox.enqueue("event", b"exact bytes", ["GRE-2", "GRE-1", "GRE-1"]))
        inbox.acknowledge("GRE-1", "event")
        inbox.close()
        reopened = self.inbox(max_pending_total=2)
        self.assertFalse(reopened.enqueue("event", b"exact bytes", ["GRE-1", "GRE-2"]))
        for payload, targets in ((b"changed", ["GRE-1", "GRE-2"]),
                                 (b"exact bytes", ["GRE-2"]),
                                 (b"exact bytes", ["GRE-2", "GRE-3"])):
            with self.assertRaises(DeliveryConflict):
                reopened.enqueue("event", payload, targets)
        self.assertEqual(reopened.pending("GRE-1"), [])
        self.assertEqual(reopened.pending("GRE-2"), [("event", b"exact bytes")])
        self.assertEqual(reopened.pending("GRE-3"), [])

    def test_acknowledgements_are_exact_and_preserve_remaining_order(self):
        inbox = self.inbox()
        for ident in ("z", "m", "a"):
            inbox.enqueue(ident, ident.encode(), ["GRE-1"])
        self.assertFalse(inbox.acknowledge("GRE-2", "m"))
        self.assertFalse(inbox.acknowledge("GRE-1", "missing"))
        self.assertTrue(inbox.acknowledge("GRE-1", "m"))
        self.assertFalse(inbox.acknowledge("GRE-1", "m"))
        self.assertEqual(inbox.pending("GRE-1"), [("z", b"z"), ("a", b"a")])

    def test_independent_issue_progress_while_another_remains_unacked(self):
        inbox = self.inbox(max_pending_per_issue=1)
        inbox.enqueue("shared", b"snapshot", ["GRE-1", "GRE-2"])
        inbox.acknowledge("GRE-2", "shared")
        for number in range(5):
            delivery = f"next-{number}"
            inbox.enqueue(delivery, b"next", ["GRE-2"])
            self.assertEqual(inbox.pending("GRE-2"), [(delivery, b"next")])
            inbox.acknowledge("GRE-2", delivery)
        self.assertEqual(inbox.pending("GRE-1"), [("shared", b"snapshot")])
        self.assertFalse(inbox.enqueue("shared", b"snapshot", ["GRE-1", "GRE-2"]))
        self.assertEqual(inbox.pending("GRE-2"), [])

    def test_final_ack_deletes_payload_and_dedup_history(self):
        inbox = self.inbox()
        for _ in range(5):
            self.assertTrue(inbox.enqueue("reused", b"payload", ["GRE-1", "GRE-2"]))
            inbox.acknowledge("GRE-1", "reused")
            with closing(sqlite3.connect(self.path)) as inspection:
                self.assertEqual(inspection.execute("SELECT payload FROM inbox_events").fetchall(),
                                 [(b"payload",)])
            inbox.acknowledge("GRE-2", "reused")
            with closing(sqlite3.connect(self.path)) as inspection:
                for table in ("inbox_events", "inbox_pending"):
                    self.assertEqual(inspection.execute(f"SELECT COUNT(*) FROM {table}").fetchone(), (0,))
        self.assertTrue(inbox.enqueue("reused", b"new bytes", ["GRE-3"]))

    def test_separate_connections_contend_for_atomic_capacity(self):
        for constraint in ("global", "per_issue"):
            with self.subTest(constraint=constraint), TemporaryDirectory() as directory:
                path = Path(directory) / "contended.sqlite"
                bounds = self.bounds | {"max_pending_total": 3 if constraint == "global" else 6,
                                        "max_pending_per_issue": 1 if constraint == "per_issue" else 3}
                barrier = Barrier(2)

                def contender(delivery):
                    inbox = EventInbox(path, **bounds)
                    try:
                        barrier.wait(timeout=5)
                        targets = ["shared", delivery] if constraint == "per_issue" else [delivery, delivery + "-other"]
                        try:
                            return delivery, inbox.enqueue(delivery, delivery.encode(), targets)
                        except CapacityExceeded:
                            return delivery, False
                    finally:
                        inbox.close()

                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(contender, delivery) for delivery in ("first", "second")]
                    outcomes = [future.result(timeout=10) for future in futures]
                self.assertEqual(sorted(accepted for _, accepted in outcomes), [False, True])
                inspector = EventInbox(path, **bounds)
                try:
                    for delivery, accepted in outcomes:
                        self.assertEqual(inspector.pending(delivery),
                                         [(delivery, delivery.encode())] if accepted else [])
                        if constraint == "global":
                            self.assertEqual(inspector.pending(delivery + "-other"),
                                             [(delivery, delivery.encode())] if accepted else [])
                    if constraint == "per_issue":
                        winner = next(delivery for delivery, accepted in outcomes if accepted)
                        self.assertEqual(inspector.pending("shared"), [(winner, winner.encode())])
                finally:
                    inspector.close()

    def test_retained_removal_through_production_apply_event_and_negative_controls(self):
        for old_body, others, state, comments, writes in (
            ("Refs GRE-1", [], "In Progress",
             [{"issueId": "1", "body": "[pr-status-sync] PR #1 removed its reference; no other open PR."}],
             [("retained", "In Progress")]),
            ("Refs GRE-1", [pr(number=2)], "In Review", [], []),
            ("No past ticket reference.", [], "In Review", [], []),
        ):
            with self.subTest(old_body=old_body, other_open=bool(others)):
                store = fake.ConcurrentWriteReproduction()
                store.setUp()
                try:
                    store.issues = {"GRE-1": ticket(state="In Review", age=1)}
                    current = pr(body="Current description without a ticket.")
                    previous = dict(current, body=old_body)
                    runner = store.runner("retained", [previous, *others])
                    runner.apply_event(previous, {"action": "opened"})
                    self.assertEqual(store.comments, [])
                    self.assertEqual(store.writes, [])
                    runner._prs = copy.deepcopy([current, *others])
                    event = {"action": "edited", "changes": {"body": {"from": old_body}}}
                    payload = json.dumps({"pr": current, "event": event}).encode()
                    inbox = self.inbox()
                    inbox.enqueue("removal", payload, ["GRE-1"])
                    inbox.close()
                    reopened = self.inbox()
                    delivery, retained = reopened.pending("GRE-1")[0]
                    self.assertEqual(retained, payload)
                    decoded = json.loads(retained)
                    self.assertEqual(decoded, {"pr": current, "event": event})
                    if state == "In Progress":
                        def fail_update():
                            raise RuntimeError("application failed")
                        store.before = ("retained", "issueUpdate(", fail_update)
                        with self.assertRaisesRegex(RuntimeError, "application failed"):
                            runner.apply_event(decoded["pr"], decoded["event"])
                        self.assertEqual(store.issues["GRE-1"]["state"]["name"], "In Review")
                        self.assertEqual(store.writes, [])
                    self.assertEqual(reopened.pending("GRE-1"), [(delivery, payload)])
                    runner.apply_event(decoded["pr"], decoded["event"])
                    self.assertEqual(store.issues["GRE-1"]["state"]["name"], state)
                    self.assertEqual(store.comments, comments)
                    self.assertEqual(store.writes, writes)
                    self.assertEqual(reopened.pending("GRE-1"), [(delivery, payload)])
                    self.assertTrue(reopened.acknowledge("GRE-1", delivery))
                    self.assertEqual(reopened.pending("GRE-1"), [])
                    reopened.close()
                finally:
                    store.doCleanups()


if __name__ == "__main__":
    unittest.main()
