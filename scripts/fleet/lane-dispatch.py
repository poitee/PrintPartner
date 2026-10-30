#!/usr/bin/env python3
"""Runner side of lane-dispatch: pick with next-ticket.py, find an idle VM, start a lane there.
Never claims (the Linear key is read-only); the started lane claims first, per rules.claim.
Transport is swappable: T3_TRANSPORT=https (tailnet Serve, per-VM bearer T3_TOKEN_<vm> from Environment fleet-wake) or ssh (T3_SSH_<vm>=user@host,
dedicated key from ~/.ssh config, then calls 127.0.0.1:3773 on the VM). Secrets are read from files, never printed."""
import json, os, subprocess, sys, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
VMS = ["133", "134", "135", "136"]

def read(p): return open(p).read().strip()

def t3_token(vm, env=None):
    """Bearer for one VM. T3 sessions are per-install (each VM's own data dir), so each VM has its own secret:
    T3_TOKEN_<vm> (from Environment fleet-wake), else T3_TOKEN_FILE_<vm>, else legacy shared T3_TOKEN / T3_TOKEN_FILE.
    Never logged; raises KeyError naming only the variable, never a value."""
    env = os.environ if env is None else env
    for k in (f"T3_TOKEN_{vm}", "T3_TOKEN"):
        if env.get(k, "").strip(): return env[k].strip()
    for k in (f"T3_TOKEN_FILE_{vm}", "T3_TOKEN_FILE"):
        if env.get(k) and os.path.exists(env[k]): return read(env[k])
    raise KeyError(f"no T3 token for vm{vm} (set secret T3_TOKEN_{vm})")

def t3_call(vm, tool, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}})
    tok = t3_token(vm)
    if os.environ.get("T3_TRANSPORT", "https") == "ssh":
        host = os.environ[f"T3_SSH_{vm}"]
        cmd = ["ssh", "-o", "BatchMode=yes", host, "curl -s -X POST http://127.0.0.1:3773/mcp -H 'Content-Type: application/json' -H @- --data-binary @/dev/stdin"]
        # header and body travel on stdin, so the token never hits argv or logs
        out = subprocess.run(cmd, input=f"Authorization: Bearer {tok}\n" + body, capture_output=True, text=True, timeout=60).stdout
    else:
        req = urllib.request.Request(os.environ[f"T3_URL_{vm}"].rstrip("/") + "/mcp", data=body.encode(),
              headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
        out = urllib.request.urlopen(req, timeout=60).read().decode()
    return parse_rpc(out)

def parse_rpc(out):
    """JSON-RPC reply from a plain JSON or SSE (data: lines) body. Raises on a JSON-RPC error."""
    for line in reversed(out.splitlines()):
        if line.startswith("data:"):
            out = line[5:].strip(); break
    r = json.loads(out[out.find("{"):])
    if "error" in r: raise RuntimeError(f"mcp error {r['error'].get('code')}")
    return r

def running_threads(vm):
    r = t3_call(vm, "t3_thread_list", {"status": ["running", "waiting"]})
    return r.get("result", {}).get("structuredContent", {}).get("threads", [])

def main():
    import yaml, importlib.util
    rules = yaml.safe_load(open(os.environ["RULES"]))
    spec = importlib.util.spec_from_file_location("nt", os.path.join(os.path.dirname(__file__), "next-ticket.py"))
    nt = importlib.util.module_from_spec(spec); spec.loader.exec_module(nt)
    os.environ["LINEAR_API_KEY"] = read(os.environ["LINEAR_KEY_FILE"])
    busy, load, v11 = [], {}, 0
    for vm in VMS:
        try:
            th = [t for t in running_threads(vm) if t.get("providerInstanceId") != "pi"]
        except Exception as e:
            print(f"vm{vm}: unreachable ({type(e).__name__})")  # type only: never echo a token; continue
            continue
        load[vm] = len(th)
        for t in th:
            busy += [w for w in t.get("title", "").replace(":", " ").split() if w.startswith("GRE-")]
            v11 += any(1008 <= int(w[4:]) <= 1031 for w in t.get("title", "").split() if w.startswith("GRE-") and w[4:].isdigit())
    issues = nt.fetch(os.environ["LINEAR_API_KEY"], rules)
    fin = [os.environ["FINISHED"]] if os.environ.get("FINISHED") else []
    got = nt.pick(issues, rules, finished=fin, busy=busy, v11_running=v11)
    if not got: print("no ready ticket"); return
    cls, i = got
    cap = rules["caps"]["threads_per_vm"]
    free = [vm for vm in ([os.environ["FORCE_VM"]] if os.environ.get("FORCE_VM") else VMS) if load.get(vm, cap) < cap]
    print(f"pick {i['id']} ({cls}) {i['title']}; free VMs {free}")
    if not free or os.environ.get("DRY_RUN") == "true": return
    vm = free[0]
    msg = (f"You are a Print Partner lane on VM{vm}. Ticket {i['id']} \"{i['title']}\". Follow ~/.claude/CLAUDE.md and the common lane brief. "
           f"FIRST claim it per ~/fleet/lane-rules.yaml claim (Linear MCP: In Progress, assignee, fleet-claim comment, earliest claim wins; back off if not yours). "
           f"Then work it in a fresh worktree from origin/main and tell Dev Foreman the branch.")
    m = rules["models"]["author"]
    r = t3_call(vm, "t3_thread_launch", {"title": f"{i['id']} lane (dispatch)", "runtimeMode": rules["runtime_mode"],
        "modelSelection": {"instanceId": m["instanceId"], "model": m["model"], "options": m["options"]}, "message": msg,
        **({"projectId": os.environ[f"T3_PROJECT_{vm}"]} if os.environ.get(f"T3_PROJECT_{vm}") else {"scratch": True})})
    print(f"started {i['id']} on vm{vm}: {json.dumps(r.get('result', {}))[:200]}")

if __name__ == "__main__":
    main()
