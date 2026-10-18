from copy import deepcopy
from dataclasses import asdict
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import census


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"


def fixture(name):
    return json.loads((FIXTURES / f"{name}-pages.json").read_text())


def capture_pages(pages):
    result = subprocess.CompletedProcess([], 0, json.dumps(pages), "")
    with patch.object(census.subprocess, "run", return_value=result):
        return census.capture("Example/Repo")


def sample(name="before", day="04"):
    snapshot = capture_pages(fixture(name))
    snapshot.collection_started_at = f"2026-10-{day}T11:00:00Z"
    snapshot.collection_finished_at = f"2026-10-{day}T11:01:00Z"
    return snapshot


def many_pages(count):
    seed = fixture("before")[0]["actions_caches"][0]
    values = [dict(seed, id=index + 1) for index in range(count)]
    return [{"total_count": count, "actions_caches": values[start:start + 100]}
            for start in range(0, max(1, count), 100)]


class InventoryTests(unittest.TestCase):
    def test_snapshot_round_trip_and_required_entry_fields(self):
        snapshot = sample()
        loaded = census.load_snapshot(census.parse_json(json.dumps(asdict(snapshot))))
        self.assertEqual(loaded, snapshot)
        self.assertEqual(snapshot.repository, "example/repo")
        self.assertEqual(set(snapshot.entries), {"11", "12", "13", "14"})
        self.assertEqual(set(snapshot.entries["11"]), set(census.ENTRY_FIELDS))
        self.assertEqual(snapshot.api, {"per_page": 100, "pages": [
            {"page": 1, "total_count": 4, "entries_count": 4}]})

    def test_aggregation_by_key_ref_pair_and_family(self):
        report = census.summary(sample())
        inventory = report["inventory"]
        self.assertEqual((inventory["entries"], inventory["size_in_bytes"]), (4, 350))
        self.assertEqual(inventory["by_key"][0], {
            "key": "buildkit-blob-1-sha256:aaa", "entries": 2, "size_in_bytes": 300})
        self.assertEqual(inventory["by_ref"], [
            {"ref": "refs/heads/main", "entries": 3, "size_in_bytes": 150},
            {"ref": "refs/pull/9/merge", "entries": 1, "size_in_bytes": 200}])
        self.assertEqual(inventory["by_key_ref"][:2], [
            {"key": "buildkit-blob-1-sha256:aaa", "ref": "refs/heads/main", "entries": 1, "size_in_bytes": 100},
            {"key": "buildkit-blob-1-sha256:aaa", "ref": "refs/pull/9/merge", "entries": 1, "size_in_bytes": 200}])
        self.assertEqual(inventory["by_family"], [
            {"family": "buildkit-blob", "entries": 2, "size_in_bytes": 300},
            {"family": "sccache", "entries": 1, "size_in_bytes": 40},
            {"family": "setup-node", "entries": 1, "size_in_bytes": 10}])
        self.assertIn("single snapshot", " ".join(report["limitations"]))

    def test_family_patterns_and_unknown(self):
        for key, expected in [
            ("buildkit-blob-1-sha256:abc", "buildkit-blob"), ("sccache-Linux-abc", "sccache"),
            ("node-cache-Linux-x64-npm-hash", "setup-node"), ("setup-python-Linux-pip-hash", "setup-python"),
            ("v0-rust-rust-linux-Linux-hash", "rust-cache"), ("tauri-cli-2.12.1-arm64-hash", "tauri-cli"),
            ("sccacheish", "other"), ("new-unrecognized-key", "other"),
        ]:
            with self.subTest(key=key):
                self.assertEqual(census.key_family(key), expected)

    def test_empty_snapshot_and_summary(self):
        snapshot = sample("empty")
        self.assertEqual(snapshot.entries, {})
        self.assertEqual(census.summary(snapshot)["inventory"], {
            "entries": 0, "size_in_bytes": 0, "by_key": [], "by_ref": [], "by_key_ref": [], "by_family": []})

    def test_full_and_partial_pagination(self):
        for count in (100, 101, 200, 201):
            with self.subTest(count=count):
                snapshot = capture_pages(many_pages(count))
                self.assertEqual(len(snapshot.entries), count)
                self.assertEqual(len(snapshot.api["pages"]), (count + 99) // 100)
                self.assertEqual(census.summary(snapshot)["inventory"]["size_in_bytes"], count * 100)

    def test_incomplete_and_inconsistent_pages(self):
        pages = many_pages(101)
        short_first = deepcopy(pages)
        short_first[0]["actions_caches"].pop()
        changed_count = deepcopy(pages)
        changed_count[1]["total_count"] = 102
        excess_page = many_pages(100) + [{"total_count": 100, "actions_caches": []}]
        for invalid in (pages[:1], short_first, changed_count, excess_page, [], {},
                        [{"total_count": 1, "actions_caches": []}],
                        [{"total_count": 0}], [{"total_count": True, "actions_caches": []}]):
            with self.subTest(pages=repr(invalid)[:90]):
                with self.assertRaises(census.CensusError):
                    capture_pages(invalid)

    def test_duplicate_id_in_or_across_pages(self):
        same_page = fixture("before")
        same_page[0]["actions_caches"][1]["id"] = 11
        across_pages = many_pages(101)
        across_pages[1]["actions_caches"][0]["id"] = 1
        for pages in (same_page, across_pages):
            with self.assertRaisesRegex(census.CensusError, "duplicate cache id"):
                capture_pages(pages)

    def test_malformed_entries(self):
        for field, value in [("id", True), ("id", "11"), ("id", 0), ("size_in_bytes", -1),
                             ("size_in_bytes", 1.5), ("key", ""), ("ref", None), ("version", 3),
                             ("created_at", "2026-99-01T10:00:00Z"),
                             ("created_at", "2026-10-01T10:00:00"),
                             ("last_accessed_at", "2026-09-01T10:00:00Z")]:
            with self.subTest(field=field, value=value):
                pages = fixture("before")
                pages[0]["actions_caches"][0][field] = value
                with self.assertRaises(census.CensusError):
                    capture_pages(pages)
        pages = fixture("before")
        del pages[0]["actions_caches"][0]["version"]
        with self.assertRaisesRegex(census.CensusError, "missing required"):
            capture_pages(pages)

    def test_malformed_snapshots(self):
        original = asdict(sample())
        for field, value in [("schema_version", True), ("schema_version", 2), ("entries", []),
                             ("repository", "owner/repo?key=x"), ("api", {}),
                             ("collection_finished_at", "2026-10-03T00:00:00Z")]:
            with self.subTest(field=field):
                document = dict(original, **{field: value})
                with self.assertRaises(census.CensusError):
                    census.load_snapshot(document)
        original["entries"]["wrong"] = original["entries"].pop("11")
        with self.assertRaisesRegex(census.CensusError, "map key"):
            census.load_snapshot(original)

    def test_duplicate_json_fields(self):
        with self.assertRaisesRegex(census.CensusError, "duplicate JSON field"):
            census.parse_json('{"entries":{"11":{},"11":{}}}')

    def test_snapshot_evidence_revalidated(self):
        for field, value in [("page", 2), ("entries_count", 3), ("total_count", 5)]:
            document = asdict(sample())
            document["api"]["pages"][0][field] = value
            with self.assertRaises(census.CensusError):
                census.load_snapshot(document)

    def test_gh_failure_despite_valid_stdout(self):
        result = subprocess.CompletedProcess([], 1, json.dumps(fixture("before")), "HTTP 403")
        with patch.object(census.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(census.CensusError, "HTTP 403"):
                census.capture("owner/repo")

    def test_missing_gh(self):
        with patch.object(census.subprocess, "run", side_effect=FileNotFoundError("gh")):
            with self.assertRaisesRegex(census.CensusError, "cannot run gh"):
                census.capture("owner/repo")


class ComparisonTests(unittest.TestCase):
    def test_disappearance_and_same_key_replacement(self):
        report = census.compare(sample(), sample("after", "05"))
        self.assertEqual(report["retained_entries"], 2)
        self.assertEqual([entry["id"] for entry in report["disappeared"]["cache_entries"]], [11, 12])
        self.assertEqual([entry["id"] for entry in report["added"]["cache_entries"]], [21])
        self.assertEqual(report["disappeared"]["size_in_bytes"], 300)
        self.assertEqual(report["added"]["size_in_bytes"], 125)
        self.assertEqual(report["disappeared"]["by_family"], [
            {"family": "buildkit-blob", "entries": 2, "size_in_bytes": 300}])
        self.assertEqual(report["net_change"], {"entries": -1, "size_in_bytes": -175})
        self.assertIn("Disappearance does not establish eviction", " ".join(report["limitations"]))

    def test_empty_transitions(self):
        for before, after, disappeared, added in [
            (sample("empty"), sample("empty", "05"), 0, 0),
            (sample(), sample("empty", "05"), 4, 0),
            (sample("empty"), sample("after", "05"), 0, 3),
        ]:
            report = census.compare(before, after)
            self.assertEqual(report["disappeared"]["entries"], disappeared)
            self.assertEqual(report["added"]["entries"], added)

    def test_access_updates_are_retained(self):
        before, after = sample("after"), sample("after", "05")
        after.entries["13"]["last_accessed_at"] = "2026-10-05T10:00:00Z"
        report = census.compare(before, after)
        self.assertEqual(report["retained_entries"], 3)
        self.assertEqual(report["added"]["entries"], 0)
        self.assertEqual(report["disappeared"]["entries"], 0)

    def test_reverse_equal_and_overlapping_time(self):
        before, after = sample(), sample("after", "05")
        with self.assertRaisesRegex(census.CensusError, "chronological"):
            census.compare(after, before)
        with self.assertRaisesRegex(census.CensusError, "chronological"):
            census.compare(before, before)
        after.collection_started_at = before.collection_finished_at
        with self.assertRaisesRegex(census.CensusError, "chronological"):
            census.compare(before, after)
        after.collection_started_at = "2026-10-04T11:00:30Z"
        with self.assertRaisesRegex(census.CensusError, "chronological"):
            census.compare(before, after)

    def test_cross_repo(self):
        after = sample("after", "05")
        after.repository = "elsewhere/repo"
        with self.assertRaisesRegex(census.CensusError, "different repositories"):
            census.compare(sample(), after)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.log = self.root / "gh-argv.json"
        gh = self.root / "gh"
        gh.write_text(
            f"#!{sys.executable}\n"
            "import json, os, pathlib, sys\n"
            "pathlib.Path(os.environ['FAKE_GH_LOG']).write_text(json.dumps(sys.argv[1:]))\n"
            "sys.stdout.write(pathlib.Path(os.environ['FAKE_GH_FIXTURE']).read_text())\n"
            "sys.stderr.write('simulated gh diagnostic')\n"
            "sys.exit(int(os.environ.get('FAKE_GH_EXIT', '0')))\n")
        gh.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ.get("PATH", ""),
                        FAKE_GH_LOG=str(self.log), FAKE_GH_FIXTURE=str(FIXTURES / "before-pages.json"))

    def cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "census.py"), *map(str, args)],
                              capture_output=True, text=True, env=self.env)

    def save(self, name, snapshot):
        path = self.root / name
        path.write_text(json.dumps(asdict(snapshot)))
        return path

    def test_capture_stdout_and_strict_get_invocation(self):
        result = self.cli("capture", "Example/Repo")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        snapshot = census.load_snapshot(json.loads(result.stdout))
        self.assertEqual(len(snapshot.entries), 4)
        self.assertEqual(json.loads(self.log.read_text()), [
            "api", "--method", "GET", "--hostname", "github.com",
            "repos/example/repo/actions/caches?per_page=100&sort=created_at&direction=asc",
            "--paginate", "--slurp", "-H", "Accept: application/vnd.github+json",
            "-H", "X-GitHub-Api-Version: 2022-11-28"])

    def test_capture_output_is_complete_and_refuses_overwrite(self):
        output = self.root / "snapshot.json"
        result = self.cli("capture", "example/repo", "--output", output)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        census.load_snapshot(json.loads(output.read_text()))
        original = output.read_bytes()
        result = self.cli("capture", "example/repo", "--output", output)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output.read_bytes(), original)
        self.assertEqual(list(self.root.glob(".cache-census-*")), [])

    def test_capture_preserves_utf8_keys_under_a_non_utf8_locale(self):
        pages = fixture("before")
        pages[0]["actions_caches"][0]["key"] = "café"
        source = self.root / "unicode.json"
        source.write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
        self.env["FAKE_GH_FIXTURE"] = str(source)
        with (patch.dict(os.environ, self.env),
              patch("locale.getpreferredencoding", return_value="iso8859-1"),
              patch("locale.getencoding", return_value="iso8859-1", create=True)):
            snapshot = census.capture("example/repo")
        self.assertEqual(snapshot.entries["11"]["key"], "café")

    def test_capture_dot_prefixed_repository(self):
        result = self.cli("capture", "Example/.github")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["repository"], "example/.github")

    def test_committed_evidence_comparison(self):
        evidence = ROOT / "evidence" / "2026-10-18"
        result = self.cli("compare", evidence / "083722.json", evidence / "083800.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual((report["disappeared"]["entries"], report["disappeared"]["size_in_bytes"]),
                         (2, 1_657_064_306))
        self.assertEqual((report["added"]["entries"], report["added"]["size_in_bytes"]),
                         (1, 742_416_946))

    def test_failed_gh_never_emits_snapshot_or_creates_output(self):
        self.env["FAKE_GH_EXIT"] = "1"
        for args in [(), ("--output", self.root / "failed.json")]:
            result = self.cli("capture", "owner/repo", *args)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertIn("gh api failed", result.stderr)
        self.assertFalse((self.root / "failed.json").exists())

    def test_malformed_or_incomplete_capture_has_no_artifact(self):
        bad = self.root / "bad.json"
        self.env["FAKE_GH_FIXTURE"] = str(bad)
        for raw in ("not json", "[]", json.dumps(many_pages(101)[:1])):
            bad.write_text(raw)
            result = self.cli("capture", "owner/repo", "--output", self.root / "failed.json")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertFalse((self.root / "failed.json").exists())

    def test_invalid_repository_never_calls_gh(self):
        result = self.cli("capture", "owner/repo?key=filtered")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.log.exists())

    def test_summary_and_compare_commands(self):
        before = self.save("before.json", sample())
        after = self.save("after.json", sample("after", "05"))
        result = self.cli("summary", before)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["inventory"]["size_in_bytes"], 350)
        result = self.cli("compare", before, after)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["disappeared"]["entries"], 2)
        self.assertFalse(self.log.exists())

    def test_invalid_saved_file_and_reverse_cli(self):
        before = self.save("before.json", sample())
        after = self.save("after.json", sample("after", "05"))
        bad = self.root / "bad.json"
        bad.write_text('{"schema_version":1}')
        for args in [("summary", bad), ("summary", self.root / "missing.json"), ("compare", after, before)]:
            result = self.cli(*args)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertIn("cache census:", result.stderr)

    def test_help_and_missing_command(self):
        result = self.cli("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("capture", result.stdout)
        self.assertIn("summary", result.stdout)
        self.assertIn("compare", result.stdout)
        self.assertEqual(self.cli().returncode, 2)


if __name__ == "__main__":
    unittest.main()
