#!/usr/bin/env python3
"""Deterministic Linear <-> GitHub PR status sync for Print Partner (no LLM).

Rules (team GRE):
  * PR open and references GRE-NNN (branch gre-NNN-*, or Refs/Fixes/Closes GRE-NNN
    in title/body)                                   -> In Review
  * PR merged with Fixes/Closes/Resolves GRE-NNN     -> Done
    Closing directives must start the title or a line, with optional Markdown.
  * PR merged with only Refs GRE-NNN (multi-slice)   -> In Progress (if another
    PR for the ticket is still open: stays In Review), comment "slice #N merged;
    next slice pending. Final slice must say 'Fixes GRE-NNN'."
  * PR closed unmerged                               -> In Progress if it was In
    Review and no other open PR (comment with reason)
  * Cron: In Progress/In Review with no PR activity for STALE_HOURS (48) and no
    open PR -> Backlog, comment "stalled: no PR/commit activity 48h".
Never touches Done/Canceled/Duplicate issues. Never prints secrets.
Fork PRs are excluded from both event handling and reconciliation.

Usage:
  pr_status_sync.py event  --pr N        # one PR (Actions pull_request event)
  pr_status_sync.py reconcile [--dry-run] # cron fallback over recent PRs
Env: LINEAR_API_KEY, GH_TOKEN (read), GITHUB_REPOSITORY (default poitee/PrintPartner)
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, time, urllib.error, urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "poitee/PrintPartner")
TEAM = os.environ.get("LINEAR_TEAM_KEY", "GRE")
STALE_HOURS = int(os.environ.get("STALE_HOURS", "48"))
DRY = False
CLOSE_RE = re.compile(r"^[ \t#>*-]*(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)[ \t]*:?[ \t]+((?:GRE-\d+\b[ \t,]*(?:and[ \t]+)?)+)", re.I | re.M)
REF_RE = re.compile(r"\b(?:refs?|part of|towards?)\s*:?\s+((?:GRE-\d+[\s,]*(?:and\s+)?)+)", re.I)
ID_RE = re.compile(r"GRE-(\d+)", re.I)
BRANCH_RE = re.compile(r"^gre-(\d+)\b", re.I)
TERMINAL = {"completed", "canceled", "duplicate"}


def gql(query, variables=None):
    key = os.environ["LINEAR_API_KEY"]
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        json.dumps({"query": query, "variables": variables or {}}).encode(),
        {"Content-Type": "application/json", "Authorization": key},
    )
    # A lost commentCreate response may hide a successful write. Only an explicit
    # rate-limit rejection is safe to replay; issueUpdate sets an absolute state.
    replay_safe = "commentCreate" not in query
    for attempt in range(3):
        try:
            try:
                response = urllib.request.urlopen(req, timeout=30)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = getattr(response, "status", None) or getattr(response, "code", 200)
                body = response.read().decode("utf-8", errors="replace")
        except OSError:
            failure = "Linear API transport failed"
            retry = replay_safe
            print(failure, file=sys.stderr)
        else:
            try:
                out = json.loads(body)
            except ValueError:
                out = {}
            if not isinstance(out, dict):
                out = {}
            errors = out.get("errors") or []
            rate_limited = bool(errors) and all(
                isinstance(error, dict) and error.get("extensions", {}).get("code") == "RATELIMITED"
                for error in errors)
            if status < 400 and not errors and "data" in out:
                return out["data"]
            diagnostic = "; ".join(
                f"{error.get('message', '')} code={error.get('extensions', {}).get('code', '')}"
                for error in errors if isinstance(error, dict)) if errors else body
            diagnostic = diagnostic.replace(key, "[REDACTED]") if key else diagnostic
            print(f"Linear API HTTP {status}: {json.dumps(diagnostic, ensure_ascii=False)}", file=sys.stderr)
            failure = "Linear API returned GraphQL errors" if errors else f"Linear API HTTP {status} failed"
            rejected = (rate_limited or status == 429) and not out.get("data")
            transient = rate_limited or status == 429 or 500 <= status < 600
            retry = transient and (replay_safe or rejected) and (not errors or rate_limited)
        if not retry or attempt == 2:
            raise RuntimeError(failure) from None
        time.sleep(2 ** attempt)


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
    key, number = ident.rsplit("-", 1)
    # A filtered connection returns no nodes for an unknown number, rather than
    # the single-entity lookup's GraphQL not-found error. Other API errors propagate.
    d = gql('query($k:String!,$n:Float!){issues(first:1,includeArchived:true,filter:{team:{key:{eq:$k}},number:{eq:$n}}){nodes{id identifier state{name type} updatedAt}}}',
            {"k": key, "n": int(number)})
    return d["issues"]["nodes"][0] if d["issues"]["nodes"] else None


def move(iss, target, comment, *, record_unchanged=False):
    cur = iss["state"]["name"]
    if (cur == target and not record_unchanged) or iss["state"]["type"] in TERMINAL:
        return False
    if DRY:
        print(f"{iss['identifier']}: {cur} -> {target} | {comment}")
        return True
    # Record the event before changing state, so a failed comment remains retryable.
    body = f"[pr-status-sync] {comment}"
    cursor = None
    while True:
        d = gql('query($id:String!,$after:String){issue(id:$id){comments(first:100,after:$after){nodes{body} pageInfo{hasNextPage endCursor}}}}',
                {"id": iss["id"], "after": cursor})["issue"]["comments"]
        if any(c["body"] == body for c in d["nodes"]):
            break
        if not d["pageInfo"]["hasNextPage"]:
            created = gql('mutation($id:String!,$b:String!){commentCreate(input:{issueId:$id,body:$b}){success}}',
                          {"id": iss["id"], "b": body})
            if not created["commentCreate"]["success"]:
                raise RuntimeError("Linear commentCreate failed")
            break
        cursor = d["pageInfo"]["endCursor"]
    if cur == target:
        return False
    updated = gql('mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}',
        {"id": iss["id"], "s": state_id(target)})
    if not updated["issueUpdate"]["success"]:
        raise RuntimeError("Linear issueUpdate failed")
    print(f"{iss['identifier']}: {cur} -> {target} | {comment}")
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


FIELDS = "number,state,title,body,headRefName,mergedAt,closedAt,updatedAt,isCrossRepository"
_prs = None
def all_prs():
    global _prs
    if _prs is None:
        owner, name = REPO.split("/", 1)
        pages = gh("api", "graphql", "--paginate", "--slurp", "-f", "query=" + '''
          query($owner:String!, $name:String!, $endCursor:String) {
            repository(owner:$owner, name:$name) {
              pullRequests(first:100, after:$endCursor, orderBy:{field:UPDATED_AT,direction:DESC}) {
                nodes { number state title body headRefName mergedAt closedAt updatedAt isCrossRepository
                  commits(last:1) { nodes { commit { committedDate } } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }''', "-f", f"owner={owner}", "-f", f"name={name}")
        _prs = [pr for page in pages for pr in page["data"]["repository"]["pullRequests"]["nodes"]
                if not pr["isCrossRepository"]]
    return _prs


def open_prs():
    return [pr for pr in all_prs() if pr["state"] == "OPEN"]


def other_open(ident, exclude):
    return [p["number"] for p in open_prs() if p["number"] != exclude and ident in refs(p)[1]]


def apply_pr(pr, errors=None):
    if pr["isCrossRepository"]:
        return
    closing, ids = refs(pr)
    n = pr["number"]
    for ident in sorted(ids):
        try:
            iss = issue(ident)
            if not iss:
                continue
            if pr["state"] == "OPEN":
                move(iss, "In Review", f"PR #{n} open: {pr['title'][:80]}")
            elif pr["state"] == "MERGED":
                slice_comment = f"slice PR #{n} merged ('Refs' only); next slice pending. Final slice PR must say 'Fixes {ident}'."
                if ident in closing:
                    move(iss, "Done", f"PR #{n} merged with 'Fixes {ident}'.")
                elif other_open(ident, n):
                    move(iss, "In Review", slice_comment, record_unchanged=True)
                elif iss["state"]["name"] in {"In Review", "In Progress"}:  # never pull Todo/Backlog back up
                    move(iss, "In Progress", slice_comment, record_unchanged=True)
            elif pr["state"] == "CLOSED" and iss["state"]["name"] == "In Review" and not other_open(ident, n):
                move(iss, "In Progress", f"PR #{n} closed without merge; no other open PR.")
        except Exception:
            if errors is None:
                raise
            errors.append(f"PR #{n} {ident}")


def apply_event(pr, event):
    if pr["isCrossRepository"]:
        return
    if event.get("action") == "edited":
        previous = dict(pr)
        for field in ("title", "body"):
            if field in event.get("changes", {}):
                previous[field] = event["changes"][field]["from"]
        removed = refs(previous)[1] - refs(pr)[1]
        for ident in sorted(removed):
            iss = issue(ident)
            if iss and iss["state"]["name"] == "In Review" and not other_open(ident, pr["number"]):
                move(iss, "In Progress", f"PR #{pr['number']} removed its reference; no other open PR.")
    apply_pr(pr)


def reconcile(hours):
    def ts(value):
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))

    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)
    prs = all_prs()
    errors = []
    recent = [p for p in prs if p["state"] == "OPEN" or ts(p["updatedAt"]) >= since]
    for p in sorted(recent, key=lambda p: ts(p["updatedAt"])):  # oldest first, newest wins
        apply_pr(p, errors)
    # stall sweep
    last = {}
    for p in prs:
        activity = [p[key] for key in ("mergedAt", "closedAt", "updatedAt") if p.get(key)]
        activity += [node["commit"]["committedDate"] for node in p.get("commits", {}).get("nodes", [])]
        t = max(ts(value) for value in activity)
        for ident in refs(p)[1]:
            last[ident] = max(last.get(ident, t), t)
    issues = []
    cursor = None
    while True:
        try:
            d = gql('query($k:String!,$after:String){issues(first:250,after:$after,filter:{team:{key:{eq:$k}},state:{name:{in:["In Progress","In Review"]}}}){nodes{id identifier updatedAt state{name type}} pageInfo{hasNextPage endCursor}}}', {"k": TEAM, "after": cursor})
        except Exception:
            errors.append("stale issue listing")
            break
        issues.extend(d["issues"]["nodes"])
        if not d["issues"]["pageInfo"]["hasNextPage"]:
            break
        cursor = d["issues"]["pageInfo"]["endCursor"]
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=STALE_HOURS)
    for iss in issues:
        ident = iss["identifier"]
        try:
            if other_open(ident, -1):
                continue
            t = max([ts(iss["updatedAt"])] + ([last[ident]] if ident in last else []))
            if t < cutoff:
                move(iss, "Backlog", f"stalled: no PR/commit activity for {STALE_HOURS}h and no open PR.")
        except Exception:
            errors.append(f"stale {ident}")
    if errors:
        raise RuntimeError("Linear reconciliation failed for: " + ", ".join(errors)) from None


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
        event = {}
        if os.environ.get("GITHUB_EVENT_PATH"):
            with open(os.environ["GITHUB_EVENT_PATH"]) as stream:
                event = json.load(stream)
        apply_event(gh("pr", "view", str(a.pr), "-R", REPO, "--json", FIELDS), event)
    else:
        reconcile(a.hours)


if __name__ == "__main__":
    sys.exit(main())
