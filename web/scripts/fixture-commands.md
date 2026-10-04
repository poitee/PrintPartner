# Run fixture tools

Run these commands from `web/`. Each command writes only below a new disposable directory.

```sh
FIXTURE_ROOT="$(mktemp -d)"
npm run fixture:plan-publication:capture -- "$FIXTURE_ROOT/plan-publication"
npm run fixture:storage:export-data -- "$FIXTURE_ROOT/storage-schema.json"
npm run fixture:storage:prepare -- "$FIXTURE_ROOT/storage"
mkdir -p "$FIXTURE_ROOT/node-access"
npm run fixture:storage:node-access -- "$FIXTURE_ROOT/node-access"
```

Always pass the output file to `fixture:storage:export-data`. If you omit it, the implementation writes `rust/crates/pp-storage/data/schema.json`.
