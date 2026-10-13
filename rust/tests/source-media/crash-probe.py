import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time

p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--binary',type=Path,required=True);p.add_argument('--fixture',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False);a.output=a.output.resolve();(a.output/'repos').mkdir();(a.output/'input').mkdir()
shutil.copyfile(a.fixture,a.output/'input/large.3mf');(a.output/'input/keep.stl').write_bytes(b'solid preserved\nendsolid preserved\n')
def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def invoke(command):return subprocess.run([str(a.binary)],input=json.dumps(command),text=True,capture_output=True)
c={'tenantId':'crash','sourceId':42,'reposDir':str(a.output/'repos'),'inputDir':str(a.output/'input'),'files':['keep.stl'],'revisionKey':'accepted'}
accepted=invoke(c);assert accepted.returncode==0; (a.output/'accepted.json').write_text(accepted.stdout)
accepted_root=a.output/'repos/42/revisions/accepted';before={str(p.relative_to(accepted_root)):sha(p) for p in accepted_root.rglob('*') if p.is_file()}
original=sha(a.output/'input/large.3mf')
c.update(files=['large.3mf'],revisionKey='after-crash');(a.output/'command.json').write_text(json.dumps(c,indent=2))
process=subprocess.Popen([str(a.binary)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
process.stdin.write(json.dumps(c));process.stdin.close();process.stdin=None
candidate=a.output/'repos/42/revisions/.pp-source-media/.candidate';derived=candidate/'_3mf/large/large.stl';start=time.monotonic();busy=None
while time.monotonic()-start<90:
    assert process.poll() is None,'conversion exited before kill point'
    if candidate.exists() and busy is None:
        busy=invoke(c);(a.output/'busy.json').write_text(busy.stdout)
        assert busy.returncode!=0 and json.loads(busy.stdout)['error']=='media-busy'
    if derived.exists() and derived.stat().st_size>100:break
    time.sleep(0.001)
else:process.kill();raise AssertionError('no live derived output within 90 seconds')
observed=derived.stat().st_size;process.kill();stdout,stderr=process.communicate();(a.output/'killed.stdout').write_text(stdout);(a.output/'killed.stderr').write_text(stderr)
assert process.returncode==-9 and candidate.exists() and not (a.output/'repos/42/revisions/after-crash').exists()
assert sha(a.output/'input/large.3mf')==original
assert {str(p.relative_to(accepted_root)):sha(p) for p in accepted_root.rglob('*') if p.is_file()}==before
retry=invoke(c);(a.output/'retry.json').write_text(retry.stdout);assert retry.returncode==0,retry.stdout
assert not candidate.exists()
assert {str(p.relative_to(accepted_root)):sha(p) for p in accepted_root.rglob('*') if p.is_file()}==before
assert sha(a.output/'input/large.3mf')==original
snapshot=json.loads(retry.stdout)['snapshot']
assert sha(a.output/'repos'/snapshot['snapshotLocator']/'large.3mf')==original
result={'passed':True,'killedExit':process.returncode,'observedDerivedBytes':observed,'concurrentOwnerRejected':True,'abandonedCandidateRecovered':True,'originalSha256':original,'acceptedPreserved':before,'retryManifestDigest':snapshot['manifestDigest']}
(a.output/'results.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
