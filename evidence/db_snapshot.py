"""Read-only DB and WAL receipt; never checkpoints or writes to SQLite."""
import hashlib, json, pathlib, sqlite3, sys, datetime
root=pathlib.Path(sys.argv[1]); db=root/'print-partner.db'
files={}
for p in [db, pathlib.Path(str(db)+'-wal')]:
 b=p.read_bytes(); files[p.name]={'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)}
with sqlite3.connect(db.as_uri()+'?mode=ro',uri=True) as con:
 tables=[r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
 counts={t:con.execute('SELECT count(*) FROM "'+t.replace('"','""')+'"').fetchone()[0] for t in tables}
log=pathlib.Path(sys.argv[2]).read_text().splitlines()
print(json.dumps({'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':files,'row_counts':counts,'mock_query_polls':sum('GET /printer/objects/query' in l for l in log)},indent=2))
