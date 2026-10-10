import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import random
import struct
import subprocess
import zipfile

p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--binary',type=Path,required=True);p.add_argument('--node',type=Path,required=True);p.add_argument('--backend',type=Path,required=True);p.add_argument('--domain',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False);a.output=a.output.resolve();rows=[]

def pkg(xml,extra=None):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('main.model',xml)
        for name,data in (extra or {}).items():z.writestr(name,data)
    return stream.getvalue()

def check(name,entries,accepted=True,parity=True,outer=False,limits=None):
    root=a.output/name;root.mkdir();source=root/'input';source.mkdir();(root/'repos').mkdir()
    for path,data in entries.items():
        target=source/path
        if path.endswith('/'):target.mkdir(parents=True,exist_ok=True)
        else:target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
    originals={p.relative_to(source).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}
    c={'tenantId':'edge','sourceId':42,'reposDir':str(root/'repos'),'inputDir':str(source),'files':list(originals),'revisionKey':name}
    if outer:
        with zipfile.ZipFile(root/'archive.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
            for path,data in entries.items():z.writestr(path,data)
        c.update(inputDir=str(root),files=[],zipPath='archive.zip')
    if limits:c['limits']=limits
    nc={**c,'reposDir':str(root/'node-repos'),'destination':str(root/'node')}
    r=subprocess.run([str(a.binary)],input=json.dumps(c),text=True,capture_output=True)
    n=subprocess.run([str(a.node),str(Path(__file__).with_name('node-oracle.mjs')),str(a.backend),str(a.domain)],input=json.dumps(nc),text=True,capture_output=True)
    for engine,process,command in [('rust',r,c),('node',n,nc)]:
        (root/f'{engine}.json').write_text(process.stdout);(root/f'{engine}-command.json').write_text(json.dumps(command,indent=2));(root/f'{engine}.stderr').write_text(process.stderr)
    assert (r.returncode==0)==accepted,(name,r.stdout,r.stderr)
    if parity:assert (n.returncode==0)==accepted,(name,n.stdout,n.stderr)
    assert {p.relative_to(source).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}==originals
    assert not (root/'repos/42/revisions/.pp-source-media/.candidate').exists()
    assert not (root/'repos/42/revisions/.pp-source-archives/.candidate').exists()
    if accepted:
        rust=json.loads(r.stdout);node=json.loads(n.stdout)
        assert rust['media']['suggestedImportRules']==node['suggestedImportRules'],(name,rust['media'],node)
        assert [{'original':x['original'],'result':x['result']} for x in rust['media']['conversions']]==[{'original':x['original'],'result':x['result']} for x in node['conversions']],name
        for key in ['manifestDigest','files','selection','publication','upstreamRevisionKey','snapshotLocator']:assert rust['snapshot'][key]==node['snapshot'][key],(name,key)
        for f in rust['snapshot']['files']:assert (root/'repos'/rust['snapshot']['snapshotLocator']/f['path']).read_bytes()==(root/'node'/f['path']).read_bytes(),(name,f)
    else:assert not (root/'repos/42/revisions'/name).exists()
    rows.append({'name':name,'passed':True,'rustAccepted':r.returncode==0,'nodeAccepted':n.returncode==0})
    (a.output/'results.json').write_text(json.dumps(rows,indent=2))

mesh="<mesh><vertex x='0' y='0' z='0'/><vertex x='1' y='0' z='0'/><vertex x='0' y='1' z='0'/><triangle v1='0' v2='1' v3='2'/></mesh>"
model='<model><object name="Part">'+mesh+'</object></model>'
check('sole-wrapper',{'kit/':b'','kit/parts/':b'','kit/parts/a.stl':b'stl','README.md':b'docs'},outer=True)
check('empty-directories',{'kit/':b'','Other/':b'','README.md':b'docs'},outer=True)
check('opaque-packages',{'_3mf/opaque.3mf':b'opaque 3mf','retained.zip':b'opaque zip','supplied.STL':b'stl'},outer=True)
check('dfs-order',{'a.3mf':pkg(model),'a/sub.3mf':pkg(model),'𐀀/end.3mf':pkg(model),'\ue000/last.3mf':pkg(model)},outer=True)
check('components-only',{'model.3mf':pkg('<model><object id="1"><components><component objectid="2"/></components></object><build><item objectid="1"/></build></model>')},accepted=False)
check('component-transform-ignored',{'model.3mf':pkg(model.replace('</model>', '<object id="2"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></components></object><build><item objectid="2"/></build></model>'))})
check('unknown-entities',{'model.3mf':pkg(model.replace('Part','a &unknown; b'))})
check('unicode-attribute-space',{'model.3mf':pkg(model.replace('name=', '\ufeffname='))})
check('xml-comment-mesh',{'model.3mf':pkg('<model><!-- <object name="Comment">'+mesh+'</object> --></model>')})
check('bad-zip',{'model.3mf':b'not zip'},accepted=False)
check('original-output-conflict',{'model.3mf':pkg(model),'_3mf/model/part.stl':b'original'},accepted=False,parity=False)
check('slug-number-conflict',{'model.3mf':pkg('<model>'+''.join('<object name="'+name+'">'+mesh+'</object>' for name in ['part','part-2','part'])+'</model>')},accepted=False,parity=False)
check('invalid-character-reference',{'model.3mf':pkg(model.replace('Part','&#xD800;'))},accepted=False,parity=False)
check('total-bound',{'model.3mf':pkg(model),'large.zip':bytes(2048)},accepted=False,parity=False,limits={'maxTotalBytes':1024})
check('names-and-defaults',{'model.3mf':pkg('<model>'+''.join('<object '+attrs+'>'+mesh+'</object>' for attrs in ['','id=""','partnumber="tok"','id="abc" name=""','name="İ ﬃ Ａ ẞ K ſ"','name="日本語"'])+'</model>')})
random.seed(812)
numbers=[0.0,-0.0,5e-324,2.2250738585072014e-308,1.7976931348623157e308,1e-6,1e-7,1e20,1e21]
while len(numbers)<1000:
    value=struct.unpack('<d',random.getrandbits(64).to_bytes(8,'little'))[0]
    if math.isfinite(value):numbers.append(value)
vertices=''.join(f'<vertex x="{value!r}" y="{value!r}" z="{value!r}"/>' for value in numbers)
triangles=''.join(f'<triangle v1="{i}" v2="{i}" v3="{i}"/>' for i in range(len(numbers)))
check('thousand-float-bit-patterns',{'model.3mf':pkg(f'<model><object><mesh>{vertices}{triangles}</mesh></object></model>')})
overflow_hypot = "<model><object><mesh><vertex x='0' y='0' z='0'/><vertex x='0' y='1e154' z='-1e154'/><vertex x='1.5e154' y='0' z='0'/><triangle v1='0' v2='1' v3='2'/></mesh></object></model>"
check('finite-cross-overflow-hypot',{'model.3mf':pkg(overflow_hypot)})
check('invalid-utf8-name', {'model.3mf':pkg(model.encode().replace(b'Part', b'Part\xff\xc2'))})
physical=pkg(model,{'second.model':model.replace('Part','Wrong')})
end=physical.index(b'PK\x05\x06');offset=struct.unpack_from('<I',physical,end+16)[0]
records=[];cursor=offset
while cursor<end:
    n,e,c=struct.unpack_from('<HHH',physical,cursor+28);length=46+n+e+c
    records.append(physical[cursor:cursor+length]);cursor+=length
reordered=physical[:offset]+b''.join(reversed(records))+physical[end:]
check('first-physical-model',{'model.3mf':reordered})
actual=pkg(model+' '*131072)
forged=bytearray(actual)
struct.pack_into('<I',forged,22,16)
central=forged.index(b'PK\x01\x02');struct.pack_into('<I',forged,central+24,16)
check('actual-model-bound',{'model.3mf':forged},accepted=False,limits={'maxModelBytes':1024})
check('unicode17-slug', {'꟱.3mf':pkg(model.replace('Part','꟱'))})
check('receipt-metadata-bound', {'model.3mf':pkg(model.replace('Part','漢'*2800000))},accepted=False,parity=False)
print(json.dumps({'passed':len(rows)}))
