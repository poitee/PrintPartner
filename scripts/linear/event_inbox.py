"""Bounded local SQLite retention candidate. No production writers use this.

Payloads are immutable bytes supplied by the caller, including the complete
original PR snapshot and event changes.from. This module does not discover refs.
Each instance owns one connection for use by one thread. No read claims work.
"""
import json
import re
import sqlite3


class CapacityExceeded(ValueError):
    """The entire enqueue was rejected. Upstream must retain the input."""


class DeliveryConflict(ValueError):
    """A retained delivery ID was reused with different bytes or targets."""


_EVENT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", re.ASCII)
_ISSUE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", re.ASCII)


def _check_id(value, pattern):
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ValueError("Invalid inbox ID format or length")


class EventInbox:
    def __init__(self, path, *, max_issues_per_event, max_pending_per_issue,
                 max_pending_total, max_payload_bytes):
        bounds = (max_issues_per_event, max_pending_per_issue,
                  max_pending_total, max_payload_bytes)
        if any(type(value) is not int or value <= 0 for value in bounds):
            raise ValueError("Inbox bounds must be positive integers")
        self._bounds = bounds
        self._db = sqlite3.connect(path, isolation_level=None)
        try:
            self._db.execute("PRAGMA foreign_keys = ON")
            with self._db:
                self._db.execute("BEGIN IMMEDIATE")
                self._db.execute("""CREATE TABLE IF NOT EXISTS inbox_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1), bounds TEXT NOT NULL)""")
                encoded_bounds = json.dumps(bounds)
                self._db.execute("INSERT OR IGNORE INTO inbox_settings VALUES (1, ?)",
                                 (encoded_bounds,))
                stored = self._db.execute("SELECT bounds FROM inbox_settings WHERE id = 1").fetchone()[0]
                if stored != encoded_bounds:
                    raise ValueError("Inbox bounds differ from persisted configuration")
                self._db.execute("""CREATE TABLE IF NOT EXISTS inbox_events (
                    sequence INTEGER PRIMARY KEY, delivery_id TEXT NOT NULL UNIQUE,
                    payload BLOB NOT NULL, targets TEXT NOT NULL)""")
                self._db.execute("""CREATE TABLE IF NOT EXISTS inbox_pending (
                    issue_id TEXT NOT NULL, event_sequence INTEGER NOT NULL
                        REFERENCES inbox_events(sequence),
                    PRIMARY KEY (issue_id, event_sequence))""")
                self._db.execute("""CREATE INDEX IF NOT EXISTS inbox_pending_event
                    ON inbox_pending(event_sequence)""")
        except BaseException:
            self._db.close()
            raise

    def close(self):
        self._db.close()

    def enqueue(self, delivery_id, payload, issue_ids):
        """Atomically accept all destinations, or reject without evicting any.

        Return True for new acceptance, False for an identical retained replay.
        Target order and duplicates do not change the destination set.
        """
        _check_id(delivery_id, _EVENT_ID)
        if not isinstance(payload, bytes):
            raise TypeError("Inbox payload must be immutable bytes")
        fanout, per_issue, total, payload_limit = self._bounds
        if len(payload) > payload_limit:
            raise CapacityExceeded("Per-event payload byte limit exceeded")
        if isinstance(issue_ids, (str, bytes)):
            raise ValueError("Issue destinations must be a collection of IDs")
        targets = set()
        for ident in issue_ids:
            _check_id(ident, _ISSUE_ID)
            targets.add(ident)
            if len(targets) > fanout:
                raise CapacityExceeded("Issue fanout limit exceeded")
        if not targets:
            raise ValueError("At least one issue destination is required")
        encoded_targets = json.dumps(sorted(targets))
        with self._db:
            self._db.execute("BEGIN IMMEDIATE")
            existing = self._db.execute(
                "SELECT payload, targets FROM inbox_events WHERE delivery_id = ?",
                (delivery_id,)).fetchone()
            if existing is not None:
                if existing != (payload, encoded_targets):
                    raise DeliveryConflict("Retained delivery has different payload or targets")
                return False
            pending = self._db.execute("SELECT COUNT(*) FROM inbox_pending").fetchone()[0]
            if pending + len(targets) > total:
                raise CapacityExceeded("Global pending delivery limit exceeded")
            for ident in targets:
                count = self._db.execute(
                    "SELECT COUNT(*) FROM inbox_pending WHERE issue_id = ?", (ident,)).fetchone()[0]
                if count >= per_issue:
                    raise CapacityExceeded("Per-issue pending limit exceeded")
            cursor = self._db.execute(
                "INSERT INTO inbox_events(delivery_id, payload, targets) VALUES (?, ?, ?)",
                (delivery_id, payload, encoded_targets))
            self._db.executemany("INSERT INTO inbox_pending VALUES (?, ?)",
                                 [(ident, cursor.lastrowid) for ident in sorted(targets)])
        return True

    def pending(self, issue_id):
        """Return ordered (delivery_id, payload) pairs without removing them."""
        _check_id(issue_id, _ISSUE_ID)
        return self._db.execute("""SELECT e.delivery_id, e.payload
            FROM inbox_pending p JOIN inbox_events e ON e.sequence = p.event_sequence
            WHERE p.issue_id = ? ORDER BY e.sequence""", (issue_id,)).fetchall()

    def acknowledge(self, issue_id, delivery_id):
        """Delete exactly this destination after successful application.

        Return whether it was pending. Final acknowledgement deletes the event,
        ending its deduplication scope. No acknowledgement history is retained.
        """
        _check_id(issue_id, _ISSUE_ID)
        _check_id(delivery_id, _EVENT_ID)
        with self._db:
            self._db.execute("BEGIN IMMEDIATE")
            deleted = self._db.execute("""DELETE FROM inbox_pending WHERE issue_id = ?
                AND event_sequence = (SELECT sequence FROM inbox_events WHERE delivery_id = ?)""",
                (issue_id, delivery_id)).rowcount
            self._db.execute("""DELETE FROM inbox_events WHERE delivery_id = ?
                AND NOT EXISTS (SELECT 1 FROM inbox_pending WHERE event_sequence = sequence)""",
                (delivery_id,))
        return bool(deleted)
