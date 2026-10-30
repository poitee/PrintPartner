#!/usr/bin/env python3
"""next-ticket.py: pick (and optionally claim) the next Todo Print Partner ticket.

Reads lane-rules.yaml (the single source of lane intake rules) and Linear.
Prints one line "GRE-n<TAB>class<TAB>title" or nothing. Always exits 0 unless --strict.

Linear data comes from, in order:
  --issues-json FILE   normalized issues (see normalize()); for tests and MCP-fed lanes
  Linear GraphQL       key read into memory from $LINEAR_API_KEY or the first existing
                       file in rules.linear_access.key_files. Never printed.
--claim needs a key with write scope. Without it the picker prints the pick and the lane
claims through the Linear MCP or the foreman (rules.claim).
"""
import argparse, json, os, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_RULES = [os.path.expanduser("~/fleet/lane-rules.yaml"), os.path.join(HERE, "..", "lane-rules.yaml"),
                 os.path.join(HERE, "lane-rules.yaml")]
GQL = "https://api.linear.app/graphql"

def load_rules(path):
    import yaml
    for p in ([path] if path else DEFAULT_RULES):
        if p and os.path.exists(p):
            with open(p) as f:
                return yaml.safe_load(f)
    sys.exit(0)  # no rules, no pick

def linear_key(rules):
    k = os.environ.get("LINEAR_API_KEY")
    if k: return k.strip()
    for p in rules.get("linear_access", {}).get("key_files", []):
        p = os.path.expanduser(p)
        if os.path.exists(p):
            with open(p) as f: return f.read().strip()
    return None

def gql(key, query, variables=None):
    req = urllib.request.Request(GQL, data=json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 headers={"Authorization": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
    if out.get("errors"): raise RuntimeError(out["errors"][0].get("message", "graphql error"))
    return out["data"]

ISSUE_FIELDS = """id identifier number title priority createdAt state{name} project{name}
 assignee{id} labels{nodes{name}}
 relations{nodes{type relatedIssue{identifier state{name}}}}
 inverseRelations{nodes{type issue{identifier state{name}}}}"""

def fetch(key, rules):
    team = rules["source"]["team"]["key"]
    states = sorted({s for c in rules["classes"].values() for s in c["pick_states"]} | {"In Progress", "In Review"})
    q = """query($team:String!,$states:[String!],$after:String){issues(first:100,after:$after,
      filter:{team:{key:{eq:$team}},state:{name:{in:$states}}}){pageInfo{hasNextPage endCursor} nodes{%s}}}""" % ISSUE_FIELDS
    out, after = [], None
    while True:
        d = gql(key, q, {"team": team, "states": states, "after": after})["issues"]
        out += [normalize(n) for n in d["nodes"]]
        if not d["pageInfo"]["hasNextPage"]: return out
        after = d["pageInfo"]["endCursor"]

def normalize(n):
    """Linear node -> {id, number, title, state, labels, priority, createdAt, blocked_by{id:state}, blocks{id:state}}."""
    if "blocked_by" in n: return n  # already normalized
    bb = {r["issue"]["identifier"]: r["issue"]["state"]["name"] for r in n["inverseRelations"]["nodes"] if r["type"] == "blocks"}
    bl = {r["relatedIssue"]["identifier"]: r["relatedIssue"]["state"]["name"] for r in n["relations"]["nodes"] if r["type"] == "blocks"}
    return {"id": n["identifier"], "uuid": n.get("id"), "number": n["number"], "title": n["title"],
            "state": n["state"]["name"], "labels": [l["name"] for l in n["labels"]["nodes"]],
            "priority": n.get("priority", 0), "createdAt": n["createdAt"], "project": (n.get("project") or {}).get("name"),
            "assignee": (n.get("assignee") or {}).get("id"), "blocked_by": bb, "blocks": bl}

def classify(i, rules):
    proj = rules["source"].get("project")
    if proj and i.get("project") not in (None, proj): return None  # project filter; MCP JSON without a project field is pre-filtered
    lo, hi = rules["classes"]["v11"]["ids_range"]
    if lo <= i["number"] <= hi:
        c = rules["classes"]["v11"]
        if i["state"] in c["pick_states"] and not set(i["labels"]) & set(c["exclude_labels"]): return "v11"
        return None
    c = rules["classes"]["parity"]
    labels = set(i["labels"])
    if i["state"] not in c["pick_states"]: return None
    if not labels & set(c["require_any_label"]) or labels & set(c["exclude_labels"]): return None
    if any(i["title"].startswith(p) for p in c.get("exclude_title_prefixes", [])): return None
    if i["number"] in c.get("exclude_ids", []): return None
    return "parity"

def deps_done(i, rules, done_extra, state_of, labels_of=None):
    done = set(rules["states"]["done_states"])
    ov = rules["dependencies"].get("overrides", {}).get(i["id"], {})
    bb = dict(i["blocked_by"])
    for x in ov.get("ignore_blocked_by", []): bb.pop(x, None)
    for x in ov.get("add_blocked_by", []): bb.setdefault(x, state_of(x))
    soft = set(rules["dependencies"].get("ignore_blockers_with_labels", []))  # umbrellas wait on their children: not real blockers
    if soft and labels_of: bb = {k: v for k, v in bb.items() if not set(labels_of(k)) & soft}
    return all(k in done_extra or v in done for k, v in bb.items())

def v11_order_ok(i, rules, done_extra, state_of):
    done = set(rules["states"]["done_states"])
    is_done = lambda t: t in done_extra or state_of(t) in done
    steps = rules["dependencies"]["v11_order"]
    named = [s for s in steps if isinstance(s, list)]
    explicit = {t for s in named for t in s}
    last = named[-1]
    for s in steps:
        if isinstance(s, list) and i["id"] in s:
            if s is last:  # last step waits for every other v11 ticket
                lo, hi = rules["classes"]["v11"]["ids_range"]
                return all(is_done(f"GRE-{n}") for n in range(lo, hi + 1) if f"GRE-{n}" not in s)
            return True
        if isinstance(s, list):
            if not all(is_done(t) for t in s): return False
        elif i["id"] not in explicit:  # screens step reached
            return True
    return True

def open_pr(ticket, repo):
    try:
        r = subprocess.run(["gh", "pr", "list", "-R", repo, "--state", "open", "--search", ticket, "--json", "number,title,headRefName"],
                           capture_output=True, text=True, timeout=60)
        prs = json.loads(r.stdout or "[]")
        return any(ticket in (p["title"] + " " + p["headRefName"]).upper() for p in prs)
    except Exception:
        return False

def pick(issues, rules, *, finished=(), busy=(), check_prs=True, v11_running=None):
    done_extra = set(finished)
    by_id = {i["id"]: i for i in issues}
    state_of = lambda t: by_id[t]["state"] if t in by_id else "Done"  # tickets outside the listed states are not blockers unless listed
    excluded = set(rules["states"]["excluded_states"])
    cands = []
    for i in issues:
        if i["id"] in busy or i["id"] in done_extra: continue
        cls = classify(i, rules)
        if not cls or not deps_done(i, rules, done_extra, state_of, lambda t: by_id[t]["labels"] if t in by_id else []): continue
        if cls == "v11" and not v11_order_ok(i, rules, done_extra, state_of): continue
        cands.append((cls, i))
    parity_open = sum(1 for i in issues if classify(i, rules) == "parity" or (i["state"] in ("In Progress", "In Review") and i["number"] not in range(rules["classes"]["v11"]["ids_range"][0], rules["classes"]["v11"]["ids_range"][1] + 1)))
    ui = rules["ui_lanes"]
    if v11_running is not None and v11_running >= ui["max_concurrent_v11"] and parity_open >= ui["raise_when_open_parity_below"]:
        cands = [(c, i) for c, i in cands if c != "v11"]
    rank = {k: v["rank"] for k, v in rules["priority_values"].items()}
    order = {c: n for n, c in enumerate(next(k["class"] for k in rules["priority_order"] if "class" in k))}
    def blocks_open(i): return sum(1 for s in i["blocks"].values() if s not in rules["states"]["done_states"])
    cands.sort(key=lambda ci: (rank.get(ci[1]["priority"], 4), order[ci[0]], -blocks_open(ci[1]), ci[1]["createdAt"]))
    for cls, i in cands:
        if check_prs and open_pr(i["id"], rules["source"]["repo"]): continue
        return cls, i
    return None

def claim(key, rules, i, vm, thread, branch):
    c = rules["claim"]
    team = rules["source"]["team"]["id"]
    st = gql(key, 'query($t:String!){team(id:$t){states{nodes{id name}}}}', {"t": team})["team"]["states"]["nodes"]
    sid = next(s["id"] for s in st if s["name"] == c["move_to_state"])
    gql(key, 'mutation($id:String!,$s:String!,$a:String!){issueUpdate(id:$id,input:{stateId:$s,assigneeId:$a}){success}}',
        {"id": i["id"], "s": sid, "a": c["assignee_id"]})
    tag = c["comment_template"].format(vm=vm, thread=thread, branch=branch, ts=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
    gql(key, 'mutation($id:String!,$b:String!){commentCreate(input:{issueId:$id,body:$b}){success}}', {"id": i["id"], "b": tag})
    time.sleep(c.get("recheck_after_s", 5))
    cm = gql(key, 'query($id:String!){issue(id:$id){comments(first:50){nodes{body createdAt}}}}', {"id": i["id"]})["issue"]["comments"]["nodes"]
    claims = sorted((x for x in cm if x["body"].startswith(c["comment_prefix"])), key=lambda x: x["createdAt"])
    return bool(claims) and claims[0]["body"] == tag  # earliest claim wins; others back off

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--rules"); ap.add_argument("--issues-json")
    ap.add_argument("--finished", action="append", default=[], help="ticket just merged; count as Done")
    ap.add_argument("--busy", action="append", default=[], help="ticket with a running lane; skip")
    ap.add_argument("--v11-running", type=int, help="running v11 lanes fleet-wide")
    ap.add_argument("--no-gh", action="store_true"); ap.add_argument("--json", action="store_true")
    ap.add_argument("--claim", action="store_true"); ap.add_argument("--vm"); ap.add_argument("--thread"); ap.add_argument("--branch")
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args(argv)
    try:
        rules = load_rules(a.rules)
        key = None
        if a.issues_json:
            issues = [normalize(n) for n in json.load(open(a.issues_json))]
        else:
            key = linear_key(rules)
            if not key: print("next-ticket: no Linear key (set LINEAR_API_KEY or a key file); use --issues-json", file=sys.stderr); return 0
            issues = fetch(key, rules)
        got = pick(issues, rules, finished=a.finished, busy=a.busy, check_prs=not a.no_gh, v11_running=a.v11_running)
        if not got: return 0
        cls, i = got
        if a.claim:
            key = key or linear_key(rules)
            if not key or not (a.vm and a.thread and a.branch):
                print("next-ticket: --claim needs a write key and --vm/--thread/--branch", file=sys.stderr); return 0
            if not claim(key, rules, i, a.vm, a.thread, a.branch):
                print(f"next-ticket: {i['id']} claimed by another lane; backing off", file=sys.stderr); return 0
        print(json.dumps({"id": i["id"], "class": cls, "title": i["title"], "claimed": a.claim}) if a.json else f"{i['id']}\t{cls}\t{i['title']}")
    except Exception as e:
        print(f"next-ticket: error {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
        if a.strict: return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
