#!/usr/bin/env python3
"""Verify fleet model scores on a PR and post the `pp/score-verified` check run.

Usage:
  pp-score-verify.py verify --repo OWNER/NAME --pr N [--dry-run]
  pp-score-verify.py self-test [--fixtures DIR]

`verify` reads the PR through the API only. It never checks out or runs PR code.
It needs GITHUB_TOKEN (pull-requests: read, issues: read, checks: write) and
reads FLEET_DEGRADED from the environment ("1" means degraded).

Rules:
- A score is a line in a PR (issue) comment by `poitee` that reads exactly
  `Score: N/10 from <model> on head <40-hex sha>`. The PR body never counts.
- A comment with more than one Score line counts for nothing.
- Only unedited comments count (updated_at == created_at). A score whose text
  changed after it was posted cannot be told apart from a forged one, so an
  edited comment is rejected; post a new comment instead.
- Valid: allowlisted model, sha equal to the full current head, N >= 8, and a
  vendor different from the Author-Vendor in the PR body's first revision.
- Pass: two distinct vendors with a valid score, or one when degraded.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

CHECK_NAME = "pp/score-verified"
SCORER_LOGIN = "poitee"
MIN_SCORE = 8

# Exact model id -> vendor. Anything not listed is rejected.
MODEL_VENDORS = {
    "halo/qwen38-flash": "qwen-local",
    "pi/halo/qwen38-flash": "qwen-local",
    "gemini-3.8-flash-high": "google",
    "composer-2.5": "cursor",
    "opencode/deepseek-v4.1-flash-free": "deepseek",
    "opencode/glm-5.3-flash-free": "zhipu",
    "opencode/mimo-v2.6-flash-free": "xiaomi",
    "opencode/nemotron-3.5-super-vl-free": "nvidia",
    "opencode/nemotron-3.5-lightning-free": "nvidia",
    "opencode/nemotron-3-ultra-free": "nvidia",
    "opencode/flint-40b-free": "flint",
}

# Author-Vendor value (lowercased) -> the vendor name MODEL_VENDORS uses.
AUTHOR_VENDOR_ALIASES = {
    "anthropic": "anthropic", "claude": "anthropic",
    "google": "google", "gemini": "google", "antigravity": "google",
    "xai": "xai", "grok": "xai",
    "cursor": "cursor", "composer": "cursor",
    "qwen": "qwen-local", "qwen-local": "qwen-local",
    "openai": "openai", "codex": "openai", "gpt": "openai",
    "deepseek": "deepseek",
    "zhipu": "zhipu", "glm": "zhipu",
    "xiaomi": "xiaomi", "mimo": "xiaomi",
    "nvidia": "nvidia", "nemotron": "nvidia",
    "flint": "flint",
}

SCORE_PREFIX = re.compile(r"^\s*Score:")
SCORE_LINE = re.compile(r"Score: (\d+)/10 from (\S+) on head (\S+)")
FULL_SHA = re.compile(r"[0-9a-f]{40}")
AUTHOR_VENDOR_LINE = re.compile(r"^\s*Author-Vendor:\s*([A-Za-z0-9-]+)", re.IGNORECASE | re.MULTILINE)


def denied(model):
    m = model.lower()
    if "grok" in m:
        return "Grok is never a scorer"
    if m.startswith("opencode-go/beam"):
        return "opencode-go/beam is never a scorer"
    if "iceman" in m:
        return "iceman models are never scorers"
    if "claude" in m:
        return "Claude authors and never scores"
    return None


def first_revision(pr):
    """Return the PR body as it was when the PR was opened, or None.

    Method: GraphQL `pullRequest.userContentEdits(last: 100)`. GitHub lists the
    edits newest first, and once a body has been edited the list also holds the
    original text as the entry with the earliest `editedAt` (its `diff` field
    holds the full body text at that revision, not a diff). `last: 100` keeps
    the oldest entries even past 100 edits. With no edits the current body is
    the first revision. If the original entry was deleted from the history
    (`deletedAt` set or `diff` null), there is no trustworthy first revision
    and this returns None.
    """
    edits = pr.get("userContentEdits", {}).get("nodes") or []
    if not edits:
        return pr.get("body") or ""
    oldest = min(edits, key=lambda e: e.get("editedAt") or "")
    if oldest.get("deletedAt") or oldest.get("diff") is None:
        return None
    return oldest["diff"]


def author_vendor(pr):
    """Return (vendor, error) from the first revision's Author-Vendor line."""
    body = first_revision(pr)
    if body is None:
        return None, "the first revision of the PR body was deleted from its edit history"
    values = {v.lower() for v in AUTHOR_VENDOR_LINE.findall(body)}
    if not values:
        return None, "the first revision of the PR body has no Author-Vendor line"
    if len(values) > 1:
        return None, f"the first revision names more than one Author-Vendor: {', '.join(sorted(values))}"
    raw = values.pop()
    vendor = AUTHOR_VENDOR_ALIASES.get(raw)
    if not vendor:
        return None, f"Author-Vendor `{raw}` is not a known vendor"
    return vendor, None


def judge_comment(comment, head_sha, author):
    """Return (vendor, verdict line) for a comment holding a Score line, or None."""
    lines = [ln for ln in (comment.get("body") or "").splitlines() if SCORE_PREFIX.match(ln)]
    if not lines:
        return None
    login = (comment.get("user") or {}).get("login") or "?"
    where = f"comment {comment.get('html_url') or comment.get('id')} by `{login}`"
    shown = lines[0].strip()

    def reject(why):
        return None, f"REJECTED `{shown}` ({where}): {why}"

    if login != SCORER_LOGIN:
        return reject(f"only comments by `{SCORER_LOGIN}` count")
    if comment.get("updated_at") != comment.get("created_at"):
        return reject("comment was edited after posting; post a new comment")
    if len(lines) > 1:
        return reject("comment holds more than one Score line")
    m = SCORE_LINE.fullmatch(lines[0])
    if not m:
        return reject("line does not match `Score: N/10 from <model> on head <40-hex sha>` exactly")
    raw_n, model, sha = m.groups()
    if not re.fullmatch(r"10|[0-9]", raw_n):
        return reject(f"score `{raw_n}` is not an integer from 0 to 10")
    if not FULL_SHA.fullmatch(sha):
        return reject(f"head `{sha}` is not a full 40-character lowercase SHA")
    if sha != head_sha:
        return reject(f"head `{sha}` is not the current head `{head_sha}`")
    why = denied(model)
    if why:
        return reject(f"model `{model}` is denied: {why}")
    vendor = MODEL_VENDORS.get(model)
    if not vendor:
        return reject(f"model `{model}` is not on the allowlist")
    if int(raw_n) < MIN_SCORE:
        return reject(f"score {raw_n} is below {MIN_SCORE}")
    if author and vendor == author:
        return reject(f"vendor `{vendor}` matches Author-Vendor; no self-scores")
    return vendor, f"ACCEPTED `{shown}` ({where}): vendor `{vendor}`"


def evaluate(pr, comments, degraded):
    """Pure decision. pr is the GraphQL pullRequest node; comments are REST issue comments."""
    head_sha = pr["headRefOid"]
    author, author_error = author_vendor(pr)
    verdicts, vendors = [], set()
    for comment in comments:
        judged = judge_comment(comment, head_sha, author)
        if judged is None:
            continue
        vendor, line = judged
        verdicts.append(line)
        if vendor:
            vendors.add(vendor)
    needed = 1 if degraded else 2
    problems = []
    if author_error:
        problems.append(author_error)
    if len(vendors) < needed:
        problems.append(f"{len(vendors)} distinct vendor(s) with a valid score; {needed} required")
    passed = not problems
    mode = "degraded (FLEET_DEGRADED=1): one vendor" if degraded else "normal: two distinct vendors"
    summary = [
        f"Head: `{head_sha}`",
        f"Author-Vendor (first revision): `{author or 'none'}`",
        f"Mode: {mode}",
        f"Valid vendors: {', '.join(f'`{v}`' for v in sorted(vendors)) or 'none'}",
        "",
        "### Scores",
        *(f"- {v}" for v in verdicts or ["No Score lines found in PR comments."]),
    ]
    if problems:
        summary += ["", "### Failing because", *(f"- {p}" for p in problems)]
    return {
        "conclusion": "success" if passed else "failure",
        "title": "Score verified" if passed else "Score not verified",
        "summary": "\n".join(summary),
        "author_vendor": author,
        "vendors": sorted(vendors),
    }


class GitHub:
    def __init__(self, token):
        self.token = token

    def request(self, method, url, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp), resp.headers.get("Link") or ""

    def graphql(self, query, variables):
        body, _ = self.request("POST", "https://api.github.com/graphql",
                               {"query": query, "variables": variables})
        if body.get("errors"):
            raise RuntimeError(f"GraphQL errors: {body['errors']}")
        return body["data"]

    def paginate(self, url):
        items = []
        while url:
            page, link = self.request("GET", url)
            items.extend(page)
            m = re.search(r'<([^>]+)>;\s*rel="next"', link)
            url = m.group(1) if m else None
        return items


PR_QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      body
      userContentEdits(last: 100) { nodes { editedAt deletedAt diff } }
    }
  }
}
"""


def verify(args):
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("GITHUB_TOKEN is not set")
    gh = GitHub(token)
    owner, name = args.repo.split("/", 1)
    pr = gh.graphql(PR_QUERY, {"owner": owner, "name": name, "number": args.pr})["repository"]["pullRequest"]
    comments = gh.paginate(f"https://api.github.com/repos/{args.repo}/issues/{args.pr}/comments?per_page=100")
    result = evaluate(pr, comments, os.environ.get("FLEET_DEGRADED") == "1")
    print(f"{CHECK_NAME}: {result['conclusion']}\n{result['summary']}")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"## {CHECK_NAME}: {result['conclusion']}\n\n{result['summary']}\n")
    if args.dry_run:
        return
    gh.request("POST", f"https://api.github.com/repos/{args.repo}/check-runs", {
        "name": CHECK_NAME,
        "head_sha": pr["headRefOid"],
        "status": "completed",
        "conclusion": result["conclusion"],
        "output": {"title": result["title"], "summary": result["summary"]},
    })


def self_test(args):
    failures = 0
    paths = sorted(Path(args.fixtures).glob("*.json"))
    for path in paths:
        case = json.loads(path.read_text())
        result = evaluate(case["pr"], case["comments"], case.get("degraded", False))
        expect = case["expect"]
        errors = []
        if result["conclusion"] != expect["conclusion"]:
            errors.append(f"conclusion {result['conclusion']} != {expect['conclusion']}")
        if "vendors" in expect and result["vendors"] != expect["vendors"]:
            errors.append(f"vendors {result['vendors']} != {expect['vendors']}")
        for text in expect.get("summary_contains", []):
            if text not in result["summary"]:
                errors.append(f"summary lacks {text!r}")
        status = "ok  " if not errors else "FAIL"
        print(f"{status} {path.stem}: {result['conclusion']} vendors={result['vendors']}")
        for e in errors:
            print(f"     {e}\n     summary:\n" + "\n".join(f"       {ln}" for ln in result["summary"].splitlines()))
        failures += bool(errors)
    print(f"{len(paths) - failures}/{len(paths)} fixtures passed")
    if not paths or failures:
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--repo", required=True)
    v.add_argument("--pr", required=True, type=int)
    v.add_argument("--dry-run", action="store_true")
    t = sub.add_parser("self-test")
    t.add_argument("--fixtures", default=str(Path(__file__).parent / "test" / "pp-score-verify"))
    args = parser.parse_args()
    verify(args) if args.cmd == "verify" else self_test(args)


if __name__ == "__main__":
    main()
