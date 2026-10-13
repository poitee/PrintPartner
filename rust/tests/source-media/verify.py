import argparse
import datetime
import hashlib
import io
import json
from pathlib import Path
import random
import struct
import subprocess
import zipfile

p = argparse.ArgumentParser()
p.add_argument('--output', type=Path, required=True)
p.add_argument('--binary', type=Path, required=True)
p.add_argument('--node', type=Path, required=True)
p.add_argument('--backend', type=Path, required=True)
p.add_argument('--domain', type=Path, required=True)
p.add_argument('--negative-control', action='store_true')
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=False)
a.output = a.output.resolve()
rows = []

def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def model(points=None, name='Front Bracket', unit='millimeter', attrs='', second=False):
    points = points or [['0', '0', '0'], ['10', '0', '0'], ['0', '5', '0']]
    vertex = ''.join('<vertex x="%s" y="%s" z="%s"/>' % tuple(p) for p in points)
    obj = f'<object id="17" name="{name}" {attrs}><mesh><vertices>{vertex}</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>'
    return f'<model unit="{unit}" xmlns="https://example.test/3mf"><resources>{obj}{obj if second else ""}</resources></model>'

def package(path, xml, trailing=0, second=None):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('3D/main.model', xml)
        if second is not None:
            z.writestr('3D/second.model', second)
        if trailing:
            z.writestr('Metadata/trailing.bin', bytes(trailing), compress_type=zipfile.ZIP_STORED)

def run(name, xml=None, filename='My Project.3mf', limits=None, accepted=True, parity=True, extra=None, trailing=0, second=None, outer=False, fixture=None):
    root = a.output / name
    root.mkdir()
    source = root / 'input'
    source.mkdir()
    if fixture:
        (source / filename).write_bytes(fixture.read_bytes())
    else:
        package(source / filename, xml if xml is not None else model(), trailing, second)
    for path, data in (extra or {}).items():
        (source / path).parent.mkdir(parents=True, exist_ok=True)
        (source / path).write_bytes(data)
    originals = {p.relative_to(source).as_posix(): sha(p) for p in source.rglob('*') if p.is_file()}
    command = {'tenantId': 'media-tenant', 'sourceId': 42, 'reposDir': str(root / 'rust-repos'), 'inputDir': str(source), 'revisionKey': name, 'files': list(originals)}
    if outer:
        with zipfile.ZipFile(root/'outer.zip', 'w', compression=zipfile.ZIP_DEFLATED) as z:
            for path in originals:
                z.write(source/path, path)
        command.update(inputDir=str(root), zipPath='outer.zip', files=[])
    if limits:
        command['limits'] = limits
    Path(command['reposDir']).mkdir()
    node_command = {**command, 'reposDir': str(root / 'node-repos'), 'destination': str(root / 'node-files')}
    oracle = Path(__file__).with_name('node-oracle.mjs')
    rust = subprocess.run([str(a.binary)], input=json.dumps(command), text=True, capture_output=True)
    node = subprocess.run([str(a.node), str(oracle), str(a.backend), str(a.domain)], input=json.dumps(node_command), text=True, capture_output=True)
    for engine, result, cmd in [('rust', rust, command), ('node', node, node_command)]:
        (root/f'{engine}.json').write_text(result.stdout)
        (root/f'{engine}.stderr').write_text(result.stderr)
        (root/f'{engine}-command.json').write_text(json.dumps(cmd, indent=2))
    r = json.loads(rust.stdout)
    n = json.loads(node.stdout)
    assert (rust.returncode == 0) == accepted, (name, r)
    assert {p.relative_to(source).as_posix(): sha(p) for p in source.rglob('*') if p.is_file()} == originals
    assert not (root/'rust-repos/42/revisions/.pp-source-media/.candidate').exists(), name
    assert not (root/'rust-repos/42/revisions/.pp-source-archives/.candidate').exists(), name
    if parity:
        assert (node.returncode == 0) == accepted, (name, n)
    if accepted:
        assert [{ 'original': c['original'], 'result': c['result'] } for c in r['media']['conversions']] == [{ 'original': c['original'], 'result': c['result'] } for c in n['conversions']], (name, r['media'], n)
        assert r['media']['selectedFiles'] == n['selectedFiles'], name
        assert n['parsedTriangles'] == [f['triangleCount'] for c in n['conversions'] for f in c['result']['files']]
        assert r['media']['suggestedImportRules'] == n['suggestedImportRules'], (name, r['media'], n)
        snapshot = root/'rust-repos'/r['snapshot']['snapshotLocator']
        for entry in r['snapshot']['files']:
            actual = snapshot/entry['path']
            expected = root/'node-files'/entry['path']
            if a.negative_control:
                assert actual.read_bytes() == expected.read_bytes() + b'negative-control', name
            assert actual.read_bytes() == expected.read_bytes(), (name, entry['path'], actual.read_text(), expected.read_text())
        for key in ['manifestDigest', 'upstreamRevisionKey', 'snapshotLocator', 'files', 'selection', 'publication']:
            assert r['snapshot'][key] == n['snapshot'][key], (name, key, r['snapshot'], n['snapshot'])
        assert r['snapshot']['tenantId'] == command['tenantId'] and r['snapshot']['sourceId'] == command['sourceId']
        assert r['snapshot']['storedBytes'] == sum(p.stat().st_size for p in snapshot.rglob('*') if p.is_file())
        assert (snapshot/'.printpartner-source-snapshot.json').read_bytes() == (root/'node-repos'/n['snapshot']['snapshotLocator']/'.printpartner-source-snapshot.json').read_bytes()
        retry = subprocess.run([str(a.binary)], input=json.dumps(command), text=True, capture_output=True)
        (root/'retry.json').write_text(retry.stdout)
        assert retry.returncode == 0 and json.loads(retry.stdout)['snapshot']['publication'] == 'reused'
        assert json.loads(retry.stdout)['snapshot']['manifestDigest'] == r['snapshot']['manifestDigest']
    else:
        assert not (root/'rust-repos/42/revisions'/name).exists(), name
    rows.append({'case': name, 'passed': True, 'rustAccepted': rust.returncode == 0, 'nodeAccepted': node.returncode == 0, 'rustError': r.get('error'), 'nodeError': n.get('error')})
    (a.output/'results.json').write_text(json.dumps({'cases': rows, 'at': datetime.datetime.now(datetime.UTC).isoformat()}, indent=2))
    return r, n

run('duplicate', model(second=True, attrs='partnumber="tok&amp;en"'))
for unit in ['micron', 'millimeter', 'centimeter', 'meter', 'inch', 'foot']:
    run('unit-'+unit, model(unit=unit, points=[['-0','0.1','2.345678901234567'],['1.2345678901234567','-0.2','-0.00000012'],['0.7','0.3333333333333333','7.9']]))
run('uppercase', model(), filename='UPPER.3MF')
run('entities', model(name='&#x43;af&#233; &amp; &QUOT; Öﬃce &#128512;', attrs='partnumber="&lt;token&gt;"'))
run('namespaced', model().replace('<object','<m:object').replace('</object','</m:object'), accepted=False)
run('namespaced-model', model(unit='inch').replace('<model','<m:model').replace('</model','</m:model'))
run('malformed-accepted', model().replace('<resources>', '<resources broken').replace('</model>', ''))
run('empty', '<model><object id="1"><mesh/></object></model>', accepted=False)
run('missing-model-object', '<model/>', accepted=False)
run('bad-unit', model(unit='yard'), accepted=False)
run('bad-index', model().replace('v3="2"','v3="3"'), accepted=False)
run('missing-coordinate', model().replace('x="10"',''), accepted=False)
run('model-bound', model(), limits={'maxModelBytes': 32}, accepted=False)
run('object-bound', model(second=True), limits={'maxObjects': 1}, accepted=False)
run('vertex-bound', model(), limits={'maxVertices': 2}, accepted=False)
run('triangle-bound', model(second=True), limits={'maxTriangles': 1}, accepted=False)
run('output-bound', model(second=True), limits={'maxOutputBytes': 250}, accepted=False)
run('first-model', model(), second=model(name='Wrong'))
r,n=run('trailing', model(), trailing=2*1024*1024)
assert r['media']['conversions'][0]['modelRead']['readBytes'] < 200000, r
assert n['conversions'][0]['readBytes'] <= 65536, n
run('unicode-rules', model(), extra={'𐀀/a.STL': b'stl', '\ue000/a.STL': b'stl', '𐀀.STL': b'stl', '\ue000.STL': b'stl'})
run('opaque-and-rules', model(), extra={'opaque.zip': b'opaque archive', 'parts/a.STL': b'solid supplied', 'notes/README.md': b'# retained'}, outer=True)
for name, points in [
    ('small', [['1e-100','0','0'],['0','2e-100','0'],['0','0','3e-100']]),
    ('large', [['1e100','0','0'],['0','2e100','0'],['0','0','3e100']]),
    ('subnormal-cross', [['0','0','0'],['1e-160','0','0'],['0','1e-160','1e-160']]),
    ('subnormal-coordinates', [['5e-324','-0','0'],['0','2e-323','0'],['0','0','3e-323']]),
    ('formatter', [['1000000000000000100','1e21','1e-7'],['0','0.000001','0'],['2','3','4']]),
    ('radix', [['0x10','','0'],['0','0b10','0'],['0','0','0o10']]),
]:
    run(name, model(points=points))
run('scaled-overflow', model(unit='meter',points=[['1e308','0','0'],['0','1','0'],['0','0','1']]), accepted=False, parity=False)
run('cross-overflow', model(points=[['0','0','0'],['1e200','0','0'],['0','1e200','0']]), accepted=False, parity=False)
random.seed(42)
for i in range(30):
    points = [[repr(random.uniform(-1000,1000)) for _ in range(3)] for _ in range(3)]
    run('oblique-'+str(i), model(points=points))
for i in range(20):
    value = random.getrandbits(random.randrange(54, 200))
    for prefix, digits in [('0x', format(value, 'x')), ('0o', format(value, 'o')), ('0b', format(value, 'b'))]:
        run('radix-wide-'+prefix+'-'+str(i), model(points=[[prefix+digits, '0', '0'], ['0', '0', '0'], ['1', '0', '0']]))
mesh = {'vertices': [[0, 0, 0], [10, 0, 0], [0, 5, 0]], 'faces': [[0, 1, 2]], 'bounds': {'minX': 0, 'minY': 0, 'minZ': 0, 'maxX': 10, 'maxY': 5, 'maxZ': 0, 'widthMm': 10, 'depthMm': 5, 'heightMm': 0}}
encode = {'operation': 'encode', 'domain': str(a.domain), 'destination': str(a.output/'node-encoded.3mf'), 'objects': [{'token': token, 'objectName': 'Front Bracket', 'xUm': i*20000, 'yUm': 0, 'mesh': mesh} for i, token in enumerate(['one', 'two'])]}
encoded = subprocess.run([str(a.node), str(Path(__file__).with_name('node-oracle.mjs')), str(a.backend), str(a.domain)], input=json.dumps(encode), text=True, capture_output=True)
(a.output/'node-encode-command.json').write_text(json.dumps(encode, indent=2))
(a.output/'node-encode.json').write_text(encoded.stdout)
assert encoded.returncode == 0, (encoded.stdout, encoded.stderr)
run('node-encoded', fixture=a.output/'node-encoded.3mf')
print(json.dumps({'passed':len(rows),'output':str(a.output)}))
