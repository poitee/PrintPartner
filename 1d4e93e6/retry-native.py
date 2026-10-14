import hashlib, json, os, subprocess
from pathlib import Path
state=Path('/persist/home/.local/state/pstack-t3/gre353-permissions')
root=Path('/persist/worktrees/t3/PrintPartner/owner-gre353-next-202610141155-6ee1')
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
assert head=='1d4e93e63313eb99d1bcbacf99cf773f720ba441'
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
stage=state/'head-stage'
binary=state/'pp-desktop'
assert json.loads((stage/'release.json').read_text())['commit']==head
assert (state/'native-build.jsonl').read_text().rstrip().endswith('target(s) in 34.59s')
assert json.loads((state/'head-native/failure.json').read_text())['error']=='Timed out: production STL WebGL canvas; last result=False'
(state/'head-native').rename(state/'head-native-attempt1')
command=['dbus-run-session','--','xvfb-run','-a','-s','-screen 0 1280x1024x24','python3','rust/tests/webkit_stl_smoke.py','--binary',str(binary),'--stage',str(stage),'--output',str(state/'head-native')]
env=dict(os.environ,LIBGL_ALWAYS_SOFTWARE='1',WEBKIT_DISABLE_DMABUF_RENDERER='1')
with (state/'native-retry.log').open('w') as log:
 subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
r=json.loads((state/'head-native/receipt.json').read_text())
assert r['result']=='PASS' and r['commit']==head and r['native_permissions']['result']=='PASS'
proof={'head':head,'result':'PASS','command':command,'preparation':'prove-head.py: web build, full-SHA staging and native build passed before first native run failed at existing STL canvas wait','retained_failure':'head-native-attempt1/failure.json','failure_message':'Timed out: production STL WebGL canvas; last result=False','retry':'same source, same staged resources, identical native binary snapshot; native run only','hashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [root/'rust/tests/webkit_stl_smoke.py',binary,stage/'bundle-manifest.json']},'binary':str(binary),'stage':str(stage),'proof_class':r['proof_class'],'native_teardown_claim':False}
(state/'head-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'result':'PASS','head':head}),flush=True)
