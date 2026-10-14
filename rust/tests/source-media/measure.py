import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import zipfile

p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--binary',type=Path,required=True);p.add_argument('--node',type=Path,required=True);p.add_argument('--backend',type=Path,required=True);p.add_argument('--domain',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False);a.output=a.output.resolve()
vertices=b"<vertex x='0.12345678901234568' y='0' z='0'/>"*200000
triangles=b"<triangle v1='0' v2='1' v3='2'/>"*100000
xml=b"<model><object name='large'><mesh>"+vertices+triangles+b"</mesh></object></model>"
assert len(xml)<=32*1024*1024
archive=a.output/'large.3mf'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('main.model',xml)
original=hashlib.sha256(archive.read_bytes()).hexdigest();rows={}
for engine in ['rust','node']:
    repos=a.output/(engine+'-repos');repos.mkdir()
    c={'tenantId':'measure','sourceId':42,'reposDir':str(repos),'inputDir':str(a.output),'files':['large.3mf'],'revisionKey':'large'}
    if engine=='node':c['destination']=str(a.output/'node-files')
    cmd=[str(a.binary)] if engine=='rust' else [str(a.node),str(Path(__file__).with_name('node-oracle.mjs')),str(a.backend),str(a.domain)]
    start=time.monotonic()
    result=subprocess.run(['/usr/bin/time','-f','%M','-o',str(a.output/(engine+'-rss.txt'))]+cmd,input=json.dumps(c),text=True,capture_output=True)
    elapsed=time.monotonic()-start
    (a.output/(engine+'.json')).write_text(result.stdout);(a.output/(engine+'.stderr')).write_text(result.stderr);(a.output/(engine+'-command.json')).write_text(json.dumps(c,indent=2))
    assert result.returncode==0,(engine,result.stdout,result.stderr)
    rows[engine]={'maxRssKiB':int((a.output/(engine+'-rss.txt')).read_text()),'elapsedSeconds':elapsed}
r=json.loads((a.output/'rust.json').read_text());n=json.loads((a.output/'node.json').read_text())
assert r['snapshot']['manifestDigest']==n['snapshot']['manifestDigest']
assert r['media']['conversions'][0]['result']==n['conversions'][0]['result']
for f in r['snapshot']['files']:
    left=a.output/'rust-repos'/r['snapshot']['snapshotLocator']/f['path'];right=a.output/'node-files'/f['path']
    with left.open('rb') as x,right.open('rb') as y:assert hashlib.file_digest(x,'sha256').digest()==hashlib.file_digest(y,'sha256').digest()
assert hashlib.sha256(archive.read_bytes()).hexdigest()==original
rows.update(modelBytes=len(xml),packageBytes=archive.stat().st_size,vertexCount=200000,triangleCount=100000,derivedBytes=r['media']['derivedBytes'],manifestDigest=r['snapshot']['manifestDigest'],passed=True)
(a.output/'results.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows))
