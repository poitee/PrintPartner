import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--binary',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False);a.output=a.output.resolve()
model=b"<model><object name='part'><mesh><vertex x='0' y='0' z='0'/><vertex x='1' y='0' z='0'/><vertex x='0' y='1' z='0'/><triangle v1='0' v2='1' v3='2'/></mesh></object></model>"
archive=a.output/'model.3mf'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_STORED) as z:z.writestr('main.model',model);z.writestr('trailing.bin',bytes(1024*1024))
original=hashlib.sha256(archive.read_bytes()).hexdigest()

def command(repos,limits=None):
    repos.mkdir();c={'tenantId':'failure','sourceId':42,'reposDir':str(repos),'inputDir':str(a.output),'files':['model.3mf'],'revisionKey':'failure'}
    if limits:c['limits']=limits
    return c

def invoke(label,cmd,syscall='read',inject=None):
    trace=a.output/f'{label}.strace';args=['strace','-yy','-o',str(trace),'-e',f'trace={syscall}']
    if inject:args+=['-e',f'inject={syscall}:error=EIO:when={inject}']
    result=subprocess.run(args+[str(a.binary)],input=json.dumps(cmd),text=True,capture_output=True)
    (a.output/f'{label}.json').write_text(result.stdout);(a.output/f'{label}-command.json').write_text(json.dumps(cmd,indent=2))
    return result,trace

rows=[]
for syscall in ['read','write']:
    baseline,trace=invoke(syscall+'-baseline',command(a.output/(syscall+'-baseline-repos')),syscall)
    assert baseline.returncode==0,(baseline.stdout,baseline.stderr)
    calls=[line for line in trace.read_text().splitlines() if line.startswith(syscall+'(')]
    needle=str(archive) if syscall=='read' else '_3mf/model/part.stl'
    candidates=[i+1 for i,line in enumerate(calls) if needle in line]
    number=candidates[0] if syscall=='read' else candidates[1]
    repos=a.output/(syscall+'-eio-repos');cmd=command(repos)
    injected,_=invoke(syscall+'-eio',cmd,syscall,number);receipt=json.loads(injected.stdout)
    assert injected.returncode!=0 and 'Input/output error' in receipt['error'],receipt
    assert not (repos/'42/revisions/.pp-source-media/.candidate').exists()
    assert not (repos/'42/revisions/failure').exists()
    retry=subprocess.run([str(a.binary)],input=json.dumps(cmd),text=True,capture_output=True)
    (a.output/f'{syscall}-retry.json').write_text(retry.stdout);assert retry.returncode==0
    rows.append({'syscall':syscall,'injectedNumber':number,'error':receipt,'retryPassed':True})

refused,trace=invoke('declared-refusal',command(a.output/'declared-repos',{'maxModelBytes':32}))
assert refused.returncode!=0 and 'model document exceeds' in refused.stdout
reads=[line for line in trace.read_text().splitlines() if str(archive) in line and line.startswith('read(')]
read_bytes=sum(int(re.search(r'= (\d+)$',line).group(1)) for line in reads if re.search(r'= (\d+)$',line))
assert read_bytes<70000,(read_bytes,reads)
assert not (a.output/'declared-repos/42/revisions/.pp-source-media/.candidate').exists()
assert hashlib.sha256(archive.read_bytes()).hexdigest()==original
rows.append({'declaredRefusalReadBytes':read_bytes,'packageBytes':archive.stat().st_size,'originalPreserved':True})
(a.output/'results.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows))
