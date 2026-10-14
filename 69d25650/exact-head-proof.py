import hashlib
import json
import os
from pathlib import Path
import subprocess
state=Path('/persist/home/.local/state/pstack-t3/gre353-frames')
root=Path('/persist/worktrees/t3/PrintPartner/owner-gre353-next-202610140800-a1c4')
sha='69d25650e183316318ac9531007614902b865dff'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==sha
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
stage=state/'verified-stage'
binary=Path('/persist/home/.local/state/pstack-t3/gre353-next/target/debug/pp-desktop')
env=dict(os.environ,CARGO_TARGET_DIR=str(binary.parents[1]),CARGO_BUILD_JOBS='4',PP_DESKTOP_RELEASE_MANIFEST=str(stage/'bundle-manifest.json'),LIBGL_ALWAYS_SOFTWARE='1',WEBKIT_DISABLE_DMABUF_RENDERER='1')
commands=[
('verified-stage.log',['python3','rust/scripts/stage-desktop.py','--web','web','--node','/opt/agent-fleet/artifacts/.local/share/mise/installs/node/24.21.0/bin/node','--output',str(stage),'--commit',sha]),
('verified-build.log',['cargo','build','--locked','--manifest-path','rust/Cargo.toml','-p','pp-desktop']),
('verified-native.log',['dbus-run-session','--','xvfb-run','-a','-s','-screen 0 1280x1024x24','python3','rust/tests/webkit_stl_smoke.py','--binary',str(binary),'--stage',str(stage),'--output',str(state/'verified-native')]),
]
for filename,command in commands:
    print(json.dumps({'running':filename,'command':command}),flush=True)
    with (state/filename).open('w') as log:
        subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
r=json.loads((state/'verified-native/receipt.json').read_text())
assert r['result']=='PASS' and r['commit']==sha
assert r['remote_frames']['observations']['native']['seconds_after_enforcing_event']>=3
proof={'head':sha,'result':'PASS','commands':commands,'hashes':{str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in [root/'rust/tests/webkit_stl_smoke.py',binary,stage/'bundle-manifest.json']},'remote_frames':r['remote_frames'],'native_teardown_claim':False,'proof_class':r['proof_class']}
(state/'exact-head-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'result':'PASS','head':sha}),flush=True)
