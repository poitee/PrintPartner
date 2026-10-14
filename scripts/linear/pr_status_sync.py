#!/usr/bin/env python3
"""Deterministic Linear <-> GitHub PR status sync for Print Partner (no LLM).

Rules (team GRE):
  * PR open and references GRE-NNN (branch gre-NNN-*, or Refs/Fixes/Closes GRE-NNN
    in title/body)                                   -> In Review
  * PR merged with Fixes/Closes/Resolves GRE-NNN     -> Done
  * PR merged with only Refs GRE-NNN (multi-slice)   -> In Progress (if another
    PR for the ticket is still open: stays In Review), comment "slice #N merged;
    next slice pending. Final slice must say 'Fixes GRE-NNN'."
  * PR closed unmerged                               -> In Progress if it was In
    Review and no other open PR (comment with reason)
  * Cron: In Progress/In Review with no PR activity for STALE_HOURS (48) and no
    open PR -> Backlog, comment "stalled: no PR/commit activity 48h".
Never touches Done/Canceled/Duplicate issues. Never prints secrets.

Usage:
  pr_status_sync.py event  --pr N        # one PR (Actions pull_request event)
  pr_status_sync.py reconcile [--dry-run] # cron fallback over recent PRs
Env: LINEAR_API_KEY, GH_TOKEN (read), GITHUB_REPOSITORY (default poitee/PrintPartner)
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "poitee/PrintPartner")
TEAM = os.environ.get("LINEAR_TEAM_KEY", "GRE")
STALE_HOURS = int(os.environ.get("STALE_HOURS", "48"))
DRY = False
CLOSE_RE = re.compile(r"\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+((?:GRE-\d+[\s,]*(?:and\s+)?)+)", re.I)
REF_RE = re.compile(r"\b(?:refs?|part of|towards?)\s*:?\s+((?:GRE-\d+[\s,]*(?:and\s+)?)+)", re.I)
ID_RE = re.compile(r"GRE-(\d+)", re.I)
BRANCH_RE = re.compile(r"^gre-(\d+)\b", re.I)
TERMINAL = {"completed", "canceled", "duplicate"}


def gql(query, variables=None):
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        json.dumps({"query": query, "variables": variables or {}}).encode(),
        {"Content-Type": "application/json", "Authorization": os.environ["LINEAR_API_KEY"]},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
    if out.get("errors"):
        raise RuntimeError(f"linear error: {out['errors'][0].get('message')}")
    return out["data"]


def gh(*args):
    return json.loads(subprocess.check_output(["gh", *args], text=True))


_states = None
def state_id(name):
    global _states
    if _states is None:
        d = gql('query($k:String!){teams(filter:{key:{eq:$k}}){nodes{states{nodes{id name}}}}}', {"k": TEAM})
        _states = {s["name"]: s["id"] for s in d["teams"]["nodes"][0]["states"]["nodes"]}
    return _states[name]


def issue(ident):
    try:
        d = gql('query($id:String!){issue(id:$id){id identifier state{name type} updatedAt}}', {"id": ident})
        return d["issue"]
    except Exception:
        return None


def move(iss, target, comment):
    cur = iss["state"]["name"]
    if cur == target or iss["state"]["type"] in TERMINAL:
        return False
    print(f"{iss['identifier']}: {cur} -> {target} | {comment}")
    if DRY:
        return True
    gql('mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}',
        {"id": iss["id"], "s": state_id(target)})
    gql('mutation($id:String!,$b:String!){commentCreate(input:{issueId:$id,body:$b}){success}}',
        {"id": iss["id"], "b": f"[pr-status-sync] {comment}"})
    return True


def refs(pr):
    """Return (closing_ids, all_ids) for a PR dict with title/body/headRefName."""
    text = f"{pr.get('title','')}\n{pr.get('body') or ''}"
    closing = {f"GRE-{n}" for m in CLOSE_RE.findall(text) for n in ID_RE.findall(m)}
    allids = set(closing)
    allids |= {f"GRE-{n}" for m in REF_RE.findall(text) for n in ID_RE.findall(m)}
    allids |= {f"GRE-{n}" for n in ID_RE.findall(pr.get("title", ""))}
    b = BRANCH_RE.match(pr.get("headRefName", ""))
    if b:
        allids.add(f"GRE-{b.group(1)}")
    return closing, allids


FIELDS = "number,state,title,body,headRefName,mergedAt,closedAt,updatedAt"
_open = None
def open_prs():
    global _open
    if _open is None:
        _open = gh("pr", "list", "-R", REPO, "--state", "open", "--limit", "200", "--json", FIELDS)
    return _open


def other_open(ident, exclude):
    return [p["number"] for p in open_prs() if p["number"] != exclude and ident in refs(p)[1]]


def apply_pr(pr):
    closing, ids = refs(pr)
    n = pr["number"]
    for ident in sorted(ids):
        iss = issue(ident)
        if not iss:
            continue
        if pr["state"] == "OPEN":
            move(iss, "In Review", f"PR #{n} open: {pr['title'][:80]}")
        elif pr["state"] == "MERGED":
            if ident in closing:
                move(iss, "Done", f"PR #{n} merged with 'Fixes {ident}'.")
            elif other_open(ident, n):
                move(iss, "In Review", f"slice PR #{n} merged; still open: #{other_open(ident, n)[0]}.")
            elif iss["state"]["name"] == "In Review":  # never pull Todo/Backlog back up
                move(iss, "In Progress", f"slice PR #{n} merged ('Refs' only); next slice pending. Final slice PR must say 'Fixes {ident}'.")
        elif pr["state"] == "CLOSED" and iss["state"]["name"] == "In Review" and not other_open(ident, n):
            move(iss, "In Progress", f"PR #{n} closed without merge; no other open PR.")


def reconcile(hours):
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)
    prs = gh("pr", "list", "-R", REPO, "--state", "all", "--limit", "200", "--json", FIELDS)
    recent = [p for p in prs if dt.datetime.fromisoformat(p["updatedAt"].replace("Z", "+00:00")) >= since]
    for p in sorted(recent, key=lambda p: p["updatedAt"]):  # oldest first, newest wins
        apply_pr(p)
    # stall sweep
    last = {}
    for p in prs:
        t = p.get("mergedAt") or p.get("closedAt") or p["updatedAt"]
        for ident in refs(p)[1]:
            last[ident] = max(last.get(ident, ""), t)
    d = gql('query($k:String!){issues(first:250,filter:{team:{key:{eq:$k}},state:{name:{in:["In Progress","In Review"]}}}){nodes{id identifier updatedAt state{name type}}}}', {"k": TEAM})
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=STALE_HOURS)
    ts = lambda v: dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    for iss in d["issues"]["nodes"]:
        ident = iss["identifier"]
        if other_open(ident, -1):
            continue
        t = max([ts(iss["updatedAt"])] + ([ts(last[ident])] if ident in last else []))
        if t < cutoff:
            move(iss, "Backlog", f"stalled: no PR/commit activity for {STALE_HOURS}h and no open PR.")


def main():
    global DRY
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["event", "reconcile"])
    ap.add_argument("--pr", type=int)
    ap.add_argument("--hours", type=int, default=3)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    DRY = a.dry_run
    if a.mode == "event":
        apply_pr(gh("pr", "view", str(a.pr), "-R", REPO, "--json", FIELDS))
    else:
        reconcile(a.hours)


if __name__ == "__main__":
    sys.exit(main())
