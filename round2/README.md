# GRE-408 base integration and verifier round 2

Head b4fb2cabde42738bbce7047bc0e8dce3d1698b20. Base c9534f00 moved the lease implementation into lease/guard.rs and brought accepted Auth, Source and packaging changes. The single conflict was lease.rs. Kept the new private guard layout, moved the shared stale-owner helper with it, and re-exported only that helper inside the crate for schema preflight. No flat storage_lease module or duplicate owner was recreated. No force push, base retarget or PR merge.

The unchanged crash test passed after this integration. Required workspace claims filter passed 15 tests, with 248 skipped. Core owner-marker replay passed all nine cases after regenerating the measured manifest at this exact head. Initial Core replay with the old manifest passed three refusal cases and failed six startup cases. Four failed directly with Release artifact content mismatch. Two failed downstream at the PP_CORE_READY and concurrent-owner assertions; the fixture subprocess also printed an artifact mismatch. The same nine cases passed after regeneration. That is retained as setup failure evidence, not a production claim. Formatting and Clippy passed. The complete serial storage replay is recorded in storage.log.

Verifier round 1 for d2409126 was cancelled before a score because the base changed and the PR conflicted. That consumes round 1 of the maximum three. Its only partial finding was that CI for d2409126 had run Evidence/parity checks, not the expected broader suite. A fresh Grok Build verifier must score this head and report the actual CI scope.

Original full GRE-408 acceptance gaps are unchanged: 28 compat-owned aliases, no production durable job client/worker and no dedicated SQLITE_FULL test. Storage-only receipts do not prove those gates. The original red crash case at old production code and its green correction remain in the parent evidence commit d85860ac993200391be7974b7dc47ad82b52505a.

Full serial storage replay: 155 tests run, 155 passed, zero skipped. Committed source bytes match source-hashes.json.
