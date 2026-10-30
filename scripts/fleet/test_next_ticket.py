import importlib.util, os, yaml
spec = importlib.util.spec_from_file_location("nt", os.path.join(os.path.dirname(__file__), "next-ticket.py"))
nt = importlib.util.module_from_spec(spec); spec.loader.exec_module(nt)
R = yaml.safe_load(open(os.path.join(os.path.dirname(__file__), "lane-rules.yaml")))
def I(n, state="Todo", labels=("fleet",), pri=3, created="2026-01-01", bb=None, bl=None, title="T"):
    return {"id": f"GRE-{n}", "number": n, "title": title, "state": state, "labels": list(labels), "priority": pri,
            "createdAt": created, "blocked_by": bb or {}, "blocks": bl or {}}
P = lambda iss, **k: (lambda r: r and r[1]["id"])(nt.pick(iss, R, check_prs=False, **k))
def test_blocked_skipped(): assert P([I(1, bb={"GRE-9": "In Progress"}), I(2)]) == "GRE-2"
def test_finished_unblocks(): assert P([I(1, bb={"GRE-9": "In Progress"}, created="2025")], finished=["GRE-9"]) == "GRE-1"
def test_excluded_label(): assert P([I(1, labels=("fleet", "umbrella")), I(2, labels=("x",))]) is None
def test_root_unblocker_first(): assert P([I(1), I(2, bl={"GRE-5": "Todo", "GRE-6": "Todo"})]) == "GRE-2"
def test_priority_zero_last(): assert P([I(1, pri=0, created="2020"), I(2, pri=4)]) == "GRE-2"
def test_oldest(): assert P([I(1, created="2026-02"), I(2, created="2026-01")]) == "GRE-2"
def test_parity_before_v11(): assert P([I(1008, state="Todo", labels=(), title="UI v11: x", pri=3, created="2027"), I(3)]) == "GRE-3"
def test_v11_order(): 
    iss = [I(1008, state="In Progress", labels=()), I(1029, labels=()), I(1012, labels=())]
    assert P(iss) is None
    assert P(iss, finished=["GRE-1008"]) == "GRE-1029"
def test_busy(): assert P([I(1), I(2, created="2027")], busy=["GRE-1"]) == "GRE-2"
def test_overrides_1009(): assert P([I(1003, state="In Progress", labels=()), I(1009, labels=())], finished=["GRE-1008","GRE-1029","GRE-1014"]) is None
def test_v11_cap(): assert P([I(1008, labels=())] + [I(n) for n in range(10, 20)], busy=[f"GRE-{n}" for n in range(10,20)], v11_running=1) is None
def test_v11_allowed_when_parity_low(): assert P([I(1008, labels=())], v11_running=1) == "GRE-1008"

def test_umbrella_blocker_ignored(): assert P([I(5, labels=("fleet","umbrella")), I(6, bb={"GRE-5": "Todo"})]) == "GRE-6"
def test_backlog_never_picked(): assert P([I(1, state="Backlog"), I(1010, state="Backlog", labels=())]) is None
def test_project_filter():
    a = dict(I(1), project="Other"); b = dict(I(2, created="2027"), project="Print Partner Desktop (Rust core)")
    assert P([a, b]) == "GRE-2"
def test_priority_beats_root_unblocker(): assert P([I(1, pri=2), I(2, pri=3, bl={"GRE-5": "Todo"})]) == "GRE-1"
def test_done_states_never_picked(): assert P([I(1, state="Done"), I(2, state="In Progress")]) is None
def test_claim_uses_uuid(monkeypatch):
    calls = []
    def gql(key, q, v):
        calls.append(v)
        if "states" in q: return {"team": {"states": {"nodes": [{"id": "s1", "name": R["claim"]["move_to_state"]}]}}}
        if "comments(" in q: return {"issue": {"comments": {"nodes": []}}}
        return {}
    monkeypatch.setattr(nt, "gql", gql); monkeypatch.setattr(nt.time, "sleep", lambda s: None)
    i = I(7); i["uuid"] = "uuid-7"; nt.claim("k", R, i, "133", "t", "b")
    assert all(v.get("id") in (None, "uuid-7") for v in calls if "id" in v)
