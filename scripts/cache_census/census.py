#!/usr/bin/env python3
"""Read-only GitHub Actions cache inventory and ID-based snapshot comparison."""

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


LIMITATIONS = [
    "Pagination is not atomic. Matching counts and unique IDs do not prove a point-in-time inventory.",
    "Disappearance does not establish eviction or its cause. Caches created and removed between samples are unseen.",
    "A single snapshot cannot measure historical eviction frequency.",
]
ENTRY_FIELDS = ("id", "key", "ref", "version", "size_in_bytes", "created_at", "last_accessed_at")
FAMILY_PATTERNS = (
    ("buildkit-blob", r"^buildkit-blob(?:-|$)"),
    ("sccache", r"^sccache(?:[-_/]|$)"),
    ("tauri-cli", r"^tauri-cli-"),
    ("setup-node", r"^node-cache-"),
    ("setup-python", r"^setup-python-"),
    ("rust-cache", r"^v\d+-rust-"),
)


class CensusError(ValueError):
    pass


@dataclass
class Snapshot:
    repository: str
    collection_started_at: str
    collection_finished_at: str
    entries: dict
    api: dict
    schema_version: int = 1


def require(condition, message):
    if not condition:
        raise CensusError(message)


def integer(value, label, minimum=0):
    require(type(value) is int and value >= minimum, f"{label} must be an integer >= {minimum}")
    return value


def timestamp(value, label):
    require(isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value
    ), f"{label} must be an ISO 8601 timestamp with timezone")
    normalized = re.sub(r"\.(\d+)", lambda match: "." + match[1][:6].ljust(6, "0"), value)
    try:
        return datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as error:
        raise CensusError(f"invalid {label}: {value}") from error


def repository_name(value):
    require(isinstance(value, str) and re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+", value
    ), "repository must be OWNER/REPO")
    require(bool(value.split("/")[1].strip(".")), "repository name must not contain only dots")
    return value.lower()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON field: {key}")
        result[key] = value
    return result


def parse_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, UnicodeError) as error:
        raise CensusError(f"invalid JSON: {error}") from error


def cache_entry(value):
    require(isinstance(value, dict), "cache entry must be an object")
    require(all(field in value for field in ENTRY_FIELDS), "cache entry is missing required fields")
    integer(value["id"], "cache id", 1)
    integer(value["size_in_bytes"], "size_in_bytes")
    for field in ("key", "ref", "version"):
        require(isinstance(value[field], str) and bool(value[field]), f"{field} must be a nonempty string")
    created = timestamp(value["created_at"], "created_at")
    accessed = timestamp(value["last_accessed_at"], "last_accessed_at")
    require(created <= accessed, "last_accessed_at precedes created_at")
    return {field: value[field] for field in ENTRY_FIELDS}


def validate_evidence(api, count):
    require(isinstance(api, dict), "api evidence must be an object")
    require(api.get("per_page") == 100 and type(api.get("per_page")) is int, "per_page must be 100")
    pages = api.get("pages")
    require(isinstance(pages, list) and bool(pages), "api evidence requires at least one page")
    total = None
    observed = 0
    for index, page in enumerate(pages):
        require(isinstance(page, dict), "page evidence must be an object")
        require(type(page.get("page")) is int and page["page"] == index + 1, "page numbers must be consecutive")
        reported = integer(page.get("total_count"), "total_count")
        if total is None:
            total = reported
        require(total == reported, "API total_count changed during pagination; retry capture")
        length = integer(page.get("entries_count"), "entries_count")
        expected = min(100, max(0, total - index * 100))
        require(length == expected, "incomplete or oversized page; retry capture")
        observed += length
    require(len(pages) == max(1, (total + 99) // 100), "incomplete or excess pagination")
    require(observed == total == count, "entry count does not match API total_count")


def load_snapshot(document):
    require(isinstance(document, dict), "snapshot must be an object")
    require(type(document.get("schema_version")) is int and document["schema_version"] == 1,
            "unsupported snapshot schema_version")
    repository = repository_name(document.get("repository"))
    start = timestamp(document.get("collection_started_at"), "collection_started_at")
    end = timestamp(document.get("collection_finished_at"), "collection_finished_at")
    require(start <= end, "collection end precedes start")
    values = document.get("entries")
    require(isinstance(values, dict), "entries must be an object keyed by cache ID")
    entries = {}
    for identifier, value in values.items():
        entry = cache_entry(value)
        require(identifier == str(entry["id"]), "entry map key does not match cache id")
        entries[identifier] = entry
    api = document.get("api")
    validate_evidence(api, len(entries))
    return Snapshot(repository, document["collection_started_at"], document["collection_finished_at"], entries, api)


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def capture(repository):
    repository = repository_name(repository)
    started = now()
    command = [
        "gh", "api", "--method", "GET", "--hostname", "github.com",
        f"repos/{repository}/actions/caches?per_page=100&sort=created_at&direction=asc",
        "--paginate", "--slurp", "-H", "Accept: application/vnd.github+json",
        "-H", "X-GitHub-Api-Version: 2022-11-28",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", check=False)
    except OSError as error:
        raise CensusError(f"cannot run gh: {error}") from error
    require(result.returncode == 0, f"gh api failed with exit {result.returncode}: {result.stderr.strip()}")
    pages = parse_json(result.stdout)
    require(isinstance(pages, list) and bool(pages), "gh --slurp must return a nonempty array of pages")
    entries = {}
    evidence = []
    for index, page in enumerate(pages):
        require(isinstance(page, dict), "API page must be an object")
        values = page.get("actions_caches")
        require(isinstance(values, list), "API page is missing actions_caches array")
        evidence.append({"page": index + 1, "total_count": page.get("total_count"), "entries_count": len(values)})
        for value in values:
            entry = cache_entry(value)
            identifier = str(entry["id"])
            require(identifier not in entries, f"duplicate cache id {identifier}; retry capture")
            entries[identifier] = entry
    snapshot = load_snapshot({
        "schema_version": 1, "repository": repository,
        "collection_started_at": started, "collection_finished_at": now(),
        "entries": entries, "api": {"per_page": 100, "pages": evidence},
    })
    return snapshot


def key_family(key):
    for family, pattern in FAMILY_PATTERNS:
        if re.match(pattern, key):
            return family
    return "other"


def aggregate(entries):
    groups = {"by_key": {}, "by_ref": {}, "by_key_ref": {}, "by_family": {}}
    size = 0
    for entry in entries:
        size += entry["size_in_bytes"]
        identities = {
            "by_key": (entry["key"],), "by_ref": (entry["ref"],),
            "by_key_ref": (entry["key"], entry["ref"]),
            "by_family": (key_family(entry["key"]),),
        }
        for name, identity in identities.items():
            group = groups[name].setdefault(identity, {"entries": 0, "size_in_bytes": 0})
            group["entries"] += 1
            group["size_in_bytes"] += entry["size_in_bytes"]
    result = {"entries": len(entries), "size_in_bytes": size}
    fields = {"by_key": ("key",), "by_ref": ("ref",), "by_key_ref": ("key", "ref"), "by_family": ("family",)}
    for name, values in groups.items():
        result[name] = [dict(zip(fields[name], identity), **values[identity]) for identity in sorted(values)]
    return result


def summary(snapshot):
    return {
        "repository": snapshot.repository,
        "collection_started_at": snapshot.collection_started_at,
        "collection_finished_at": snapshot.collection_finished_at,
        "api": snapshot.api, "inventory": aggregate(list(snapshot.entries.values())),
        "limitations": LIMITATIONS,
    }


def compare(before, after):
    require(before.repository == after.repository, "cannot compare snapshots from different repositories")
    require(timestamp(before.collection_finished_at, "before end") < timestamp(after.collection_started_at, "after start"),
            "snapshots must be chronological with nonoverlapping collection windows")
    before_ids, after_ids = set(before.entries), set(after.entries)
    result = {
        "repository": before.repository,
        "before": {"collection_started_at": before.collection_started_at, "collection_finished_at": before.collection_finished_at},
        "after": {"collection_started_at": after.collection_started_at, "collection_finished_at": after.collection_finished_at},
        "retained_entries": len(before_ids & after_ids), "limitations": LIMITATIONS,
    }
    for name, identifiers, source in (
        ("disappeared", before_ids - after_ids, before),
        ("added", after_ids - before_ids, after),
    ):
        entries = [source.entries[identifier] for identifier in sorted(identifiers, key=int)]
        result[name] = {"cache_entries": entries, **aggregate(entries)}
    result["net_change"] = {
        "entries": len(after_ids) - len(before_ids),
        "size_in_bytes": sum(entry["size_in_bytes"] for entry in after.entries.values())
        - sum(entry["size_in_bytes"] for entry in before.entries.values()),
    }
    return result


def write_output(path, text):
    destination = Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent,
                                         prefix=".cache-census-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
        os.link(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    capture_parser = commands.add_parser("capture", help="collect a validated inventory using GET requests")
    capture_parser.add_argument("repository", help="OWNER/REPO on github.com")
    capture_parser.add_argument("--output", help="atomically create a new snapshot file instead of stdout")
    summary_parser = commands.add_parser("summary", help="group a saved snapshot")
    summary_parser.add_argument("snapshot")
    compare_parser = commands.add_parser("compare", help="compare two saved snapshots by cache ID")
    compare_parser.add_argument("before")
    compare_parser.add_argument("after")
    args = parser.parse_args(argv)
    try:
        if args.command == "capture":
            report = asdict(capture(args.repository))
        elif args.command == "summary":
            report = summary(load_snapshot(parse_json(Path(args.snapshot).read_text(encoding="utf-8"))))
        else:
            before = load_snapshot(parse_json(Path(args.before).read_text(encoding="utf-8")))
            after = load_snapshot(parse_json(Path(args.after).read_text(encoding="utf-8")))
            report = compare(before, after)
        output = json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
        if getattr(args, "output", None):
            write_output(args.output, output)
        else:
            sys.stdout.write(output)
    except (CensusError, OSError, UnicodeError) as error:
        print(f"cache census: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
