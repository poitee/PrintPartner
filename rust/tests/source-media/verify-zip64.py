import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess
import zipfile

p=argparse.ArgumentParser()
p.add_argument('--output', type=Path, required=True)
p.add_argument('--binary', type=Path, required=True)
p.add_argument('--node', type=Path, required=True)
p.add_argument('--node-archive', type=Path, required=True)
a=p.parse_args(); a.output.mkdir(parents=True,exist_ok=False); a.output=a.output.resolve(); rows=[]

def archive64(data, offset=True, footer=True):
    pos=data.index(b'PK\x01\x02'); end=data.index(b'PK\x05\x06'); h=bytearray(data[pos:pos+46])
    n,e,c=struct.unpack_from('<HHH',h,28)
    compressed,raw=struct.unpack_from('<II',h,20)
    local=struct.unpack_from('<I',h,42)[0]
    extra=struct.pack('<HHQQ',1,24 if offset else 16,raw,compressed)+(struct.pack('<Q',local) if offset else b'')
    struct.pack_into('<II',h,20,0xffffffff,0xffffffff); struct.pack_into('<H',h,30,e+len(extra))
    if offset: struct.pack_into('<I',h,42,0xffffffff)
    central=bytes(h)+data[pos+46:pos+46+n]+extra+data[pos+46+n:end]
    tail=bytearray(data[end:]);struct.pack_into('<I',tail,12,len(central))
    if footer:
        record=struct.pack('<4sQHHIIQQQQ',b'PK\x06\x06',44,45,45,0,0,1,1,len(central),pos)
        locator=struct.pack('<4sIQI',b'PK\x06\x07',0,pos+len(central),1)
        struct.pack_into('<HHII',tail,8,0xffff,0xffff,0xffffffff,0xffffffff)
        return data[:pos]+central+record+locator+tail
    return data[:pos]+central+tail

def make(force=False, streaming=False, compression=zipfile.ZIP_STORED, payload=b'solid forced\nendsolid forced\n'):
    class Stream(io.BytesIO):
        def seekable(self): return False
        def seek(self,*args): raise io.UnsupportedOperation()
    buffer=Stream() if streaming else io.BytesIO()
    with zipfile.ZipFile(buffer,'w',compression=compression) as w:
        with w.open('part.stl','w',force_zip64=force) as f:f.write(payload)
    return buffer.getvalue()

def check(name,data,accepted=True,limits=None,node_unsigned_defect=False,expected_payload=b'solid forced\nendsolid forced\n'):
    root=a.output/name;root.mkdir();archive=root/'input.zip';archive.write_bytes(data);(root/'repos').mkdir()
    before=hashlib.sha256(data).hexdigest()
    cmd={'tenantId':'zip64','sourceId':42,'reposDir':str(root/'repos'),'inputDir':str(root),'zipPath':'input.zip','revisionKey':name}
    if limits:cmd['limits']=limits
    nc={'zip':str(archive),'destination':str(root/'node')}
    r=subprocess.run([str(a.binary)],input=json.dumps(cmd),text=True,capture_output=True)
    n=subprocess.run([str(a.node),str(Path(__file__).parents[1]/'source-artifacts/node-archive-oracle.mjs'),str(a.node_archive)],input=json.dumps(nc),text=True,capture_output=True)
    (root/'rust.json').write_text(r.stdout);(root/'node.json').write_text(n.stdout);(root/'command.json').write_text(json.dumps(cmd,indent=2))
    result=json.loads(r.stdout)
    assert (r.returncode==0)==accepted,(name,result)
    assert hashlib.sha256(archive.read_bytes()).hexdigest()==before
    assert not (root/'repos/42/revisions/.pp-source-archives/.candidate').exists()
    if accepted:
        assert n.returncode==0,(name,n.stdout,n.stderr)
        node_bytes=(root/'node/part.stl').read_bytes()
        rust_bytes=(root/'repos'/result['snapshot']['snapshotLocator']/'part.stl').read_bytes()
        with zipfile.ZipFile(archive) as z:
            python_bytes=z.read('part.stl')
            metadata=z.getinfo('part.stl')
        (root/'python.json').write_text(json.dumps({'filename':metadata.filename,'flags':metadata.flag_bits,'compressedSize':metadata.compress_size,'uncompressedSize':metadata.file_size,'crc':metadata.CRC,'contentHex':python_bytes.hex()},indent=2))
        assert rust_bytes==python_bytes==expected_payload
        if node_unsigned_defect:
            assert node_bytes==b'solid forced\nendsolid for',node_bytes
            assert len(node_bytes)==25 and len(rust_bytes)==29
        else:
            assert node_bytes==rust_bytes
        assert result['extraction']['archiveSha256']==before
    else:assert not (root/'repos/42/revisions'/name).exists()
    rows.append({'name':name,'passed':True,'rustAccepted':r.returncode==0,'nodeAccepted':n.returncode==0,'rustError':result.get('error'),'exactByteParity':accepted and not node_unsigned_defect,'nodeUnsignedDescriptorTruncation':node_unsigned_defect})
    (a.output/'results.json').write_text(json.dumps(rows,indent=2))

for force in [False,True]:
    for streaming in [False,True]:
        for compression in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED]:
            check(f'local-{force}-{streaming}-{compression}',make(force,streaming,compression))
for forced in [False,True]:
    data=make(forced,True)
    descriptor=data.index(b'PK\x07\x08')
    data=data[:descriptor]+data[descriptor+4:]
    data=bytearray(data)
    end=data.index(b'PK\x05\x06')
    struct.pack_into('<I',data,end+16,struct.unpack_from('<I',data,end+16)[0]-4)
    check('unsigned-descriptor-'+str(forced),data,node_unsigned_defect=True)
payload=bytes.fromhex('ac0a7ad5')
assert __import__('zlib').crc32(payload)==0x08074b50
data=make(True,True,payload=payload);descriptor=data.index(b'PK\x07\x08');data=bytearray(data[:descriptor]+data[descriptor+4:]);end=data.index(b'PK\x05\x06')
struct.pack_into('<I',data,end+16,struct.unpack_from('<I',data,end+16)[0]-4)
check('unsigned-descriptor-signature-crc',data,expected_payload=payload)
base=archive64(make(True));check('full-zip64',base)
check('central-size-only',archive64(make(True),offset=False,footer=False))
check('central-size-offset-no-footer',archive64(make(True),footer=False))
disk=bytearray(base)
central=disk.index(b'PK\x01\x02');extra=central+46+len('part.stl')
struct.pack_into('<H',disk,central+34,0xffff)
struct.pack_into('<H',disk,central+30,32)
struct.pack_into('<H',disk,extra+2,28)
disk[extra+28:extra+28]=bytes(4)
end64=disk.index(b'PK\x06\x06');locator=disk.index(b'PK\x06\x07')
struct.pack_into('<Q',disk,end64+40,struct.unpack_from('<Q',disk,end64+40)[0]+4)
struct.pack_into('<Q',disk,locator+8,end64)
check('zip64-disk-sentinel-zero',disk)
struct.pack_into('<I',disk,extra+28,1)
check('zip64-disk-sentinel-multidisk',disk,False)
for name,location,value,fmt in [
    ('forged-eocd-offset',base.index(b'PK\x06\x06')+48,2**63,'Q'),
    ('forged-eocd-size',base.index(b'PK\x06\x06')+40,2**63,'Q'),
    ('forged-eocd-count',base.index(b'PK\x06\x06')+32,10001,'Q'),
    ('multidisk-locator',base.index(b'PK\x06\x07')+16,2,'I'),
    ('multidisk-eocd',base.index(b'PK\x06\x06')+16,1,'I'),
    ('forged-locator-offset',base.index(b'PK\x06\x07')+8,2**64-1,'Q'),
    ('forged-local-size',30+len('part.stl')+4,2**63,'Q'),
    ('forged-central-localoffset',base.index(b'PK\x01\x02')+46+len('part.stl')+20,2**63,'Q'),
]:
    bad=bytearray(base);struct.pack_into('<'+fmt,bad,location,value);check(name,bad,False)
check('truncated',base[:-8],False)
bad=bytearray(base);bad[30+len('part.stl')+20]^=1;check('crc',bad,False)
check('inflated-budget',base,False,{'maxEntries':10000,'maxCompressedBytes':256*1024*1024,'maxInflatedBytes':2})
print(json.dumps({'passed':len(rows)}))
