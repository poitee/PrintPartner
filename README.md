# GRE-498 Plan controls evidence

The original Plan page is from `0e68ac73`. The new page integration suite was run with a temporary sibling copy of that page, preserving its relative imports. Two assertions fail because the controls are absent. The flag-off absence case passes. Restoring the implemented page passes all three cases. The initial missing-component import failure is not used as behavioral proof.

The persistence test passes against the shipped server. Its negative control changes only `value: JSON.stringify(raw)` in `services/plan-features.ts` to `value: "{}"`. The PATCH still reports its constructed response, but the SQLite restart assertion detects that no override was stored. The mutation was restored and no server production change is included.

Run the focused suites from `web`.

```sh
npm run test -w @print-partner/server -- src/routes/plan-features.test.ts src/routes/tenant-features.test.ts --maxWorkers=2
npm run test -w @print-partner/web -- src/components/plan/PlanFeaturesCard.test.tsx src/pages/PartsPage.features.test.tsx src/pages/PartsPage.initialization.test.tsx src/pages/PartsPage.recovery.test.tsx src/components/settings/TenantFeaturesSettingsCard.test.tsx src/pages/SettingsPage.features.test.tsx --maxWorkers=2
```

T3 preview used the real app with isolated SQLite directories. Port 5183 proxies flag-on server 18865, and 5184 proxies flag-off server 18866. `browser-proof.json` records the assertions and actions. All feature changes were made in these disposable proof instances.

- `before.png` shows the original page without controls while the capability is enabled.
- `default-off-features.png` shows all four inherited defaults off.
- `farm-saved.png` shows the farm override retained after reload.
- `all-enabled.png` shows all four explicit Plan overrides on.
- `inheritance.png` shows farm inheriting the enabled account value after clearing its explicit off override and reloading.
- `flag-off.png` shows no controls. The browser observed zero feature reads, no capability, and a direct API probe returned 404.

Local Node is 24.21.0. CI uses the repository's declared Node 22.
