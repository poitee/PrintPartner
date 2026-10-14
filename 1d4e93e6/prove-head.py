import hashlib, json, os, subprocess
from pathlib import Path
root=Path('/persist/worktrees/t3/PrintPartner/owner-gre353-next-202610141155-6ee1')
state=Path('/persist/home/.local/state/pstack-t3/gre353-permissions')
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
stage=state/'head-stage'
target=state/'target'
env=dict(os.environ,VITE_PRINT_PARTNER_DESKTOP='1',CARGO_TARGET_DIR='/persist/home/.local/state/pstack-t3/gre353-next/target',CARGO_BUILD_JOBS='4',PP_DESKTOP_RELEASE_MANIFEST=str(stage/'bundle-manifest.json'),LIBGL_ALWAYS_SOFTWARE='1',WEBKIT_DISABLE_DMABUF_RENDERER='1')
commands=[
('web-build.log',['npm','--prefix','web','run','build']),
('stage.log',['python3','rust/scripts/stage-desktop.py','--web','web','--node','/opt/agent-fleet/artifacts/.local/share/mise/installs/node/24.21.0/bin/node','--output',str(stage),'--commit',head]),
('native-build.jsonl',['cargo','build','--locked','--manifest-path','rust/Cargo.toml','-p','pp-desktop','--message-format=json']),
]
for name,command in commands:
 print('Running '+name,flush=True)
 with (state/name).open('w') as log:
  subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
artifacts=[]
for line in (state/'native-build.jsonl').read_text().splitlines():
 try: value=json.loads(line)
 except json.JSONDecodeError: continue
 if value.get('reason')=='compiler-artifact' and value.get('target',{}).get('name')=='pp-desktop' and value.get('executable'): artifacts.append(value['executable'])
binary=Path(artifacts[-1])
command=['dbus-run-session','--','xvfb-run','-a','-s','-screen 0 1280x1024x24','python3','rust/tests/webkit_stl_smoke.py','--binary',str(binary),'--stage',str(stage),'--output',str(state/'head-native')]
print('Running native verification',flush=True)
with (state/'native.log').open('w') as log:
 subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
r=json.loads((state/'head-native/receipt.json').read_text())
assert r['result']=='PASS' and r['commit']==head and r['native_permissions']['result']=='PASS'
proof={'head':head,'result':'PASS','commands':commands+[('native.log',command)],'hashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [root/'rust/tests/webkit_stl_smoke.py',binary,stage/'bundle-manifest.json']},'binary':str(binary),'stage':str(stage),'proof_class':r['proof_class'],'native_teardown_claim':False}
(state/'head-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps(proof),flush=True)
