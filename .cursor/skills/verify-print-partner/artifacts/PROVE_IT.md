# Prove-it log (cloud agent)

Commands run against isolated Docker on `127.0.0.1:8080` (not LAN).

```bash
CONTROL="node .cursor/skills/verify-print-partner/helpers/control-print-partner.mjs"
$CONTROL launch --mode docker --evidence-dir /tmp/pp-verify-evidence/prove-it
$CONTROL doctor
$CONTROL navigate --path /library --theme dark
$CONTROL snapshot --path /library --out /tmp/pp-verify-evidence/prove-it/sources-library.aria.txt
$CONTROL screenshot --path /library --out /tmp/pp-verify-evidence/prove-it/sources-library.png
$CONTROL cleanup
test -f /tmp/pp-verify-evidence/prove-it/sources-library.png
```

Results:

- doctor: pass (health ok, compose running, UI reachable, version `3.3.0-web`)
- navigate `/library`: heading `Source Library`
- evidence retained after cleanup: `sources-library.png`, `sources-library.aria.txt`
- live LAN walk: skipped (cloud cannot reach `192.168.200.80`)
