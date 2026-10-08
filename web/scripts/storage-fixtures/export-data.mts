import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { mock } from 'node:test';
import { schemaMigrations } from '../../apps/server/src/db/migrations-sqlite.js';
import { seedStarterProfiles } from '../../apps/server/src/db/seed-starter-profiles.js';
import { SOURCE_REVISION_TENANT_REPAIR_STATEMENTS, STRANDED_SOURCE_REVISION_QUERY } from '../../apps/server/src/db/source-revision-tenant-repair.js';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const root = new URL('../../../rust/crates/pp-storage/data/', import.meta.url);
const db = new Database(':memory:');
for (const sql of schemaMigrations) {
    try {
        db.exec(sql);
    }
    catch (error) {
        if (!/duplicate column name/i.test(String(error)))
            throw error;
    }
}
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-02T00:00:00.000Z') });
seedStarterProfiles(db);
const groups = [
    { table: 'printer_profiles', columns: ['tenant_id', 'name', 'slicer_format', 'extruder_count', 'resolved_flat_config', 'imported_at'] },
    { table: 'process_profiles', columns: ['tenant_id', 'name', 'slicer_format', 'compatible_printers', 'resolved_flat_config', 'imported_at'] },
    { table: 'filament_profiles', columns: ['tenant_id', 'name', 'material_type', 'material_tier', 'nozzle_temp_c', 'bed_temp_c', 'fan_pct', 'extrusion_multiplier', 'pressure_advance', 'retraction', 'resolved_flat_config', 'imported_at'] },
].map(group => ({ ...group, rows: db.prepare(`SELECT ${group.columns.join(',')} FROM ${group.table} ORDER BY id`).raw().all() }));
const source = readFileSync(new URL('../../apps/server/src/db/client.ts', import.meta.url), 'utf8');
const extras = [...source.matchAll(/this\.sqlite\.exec\(`([\s\S]*?)`\)/g)].map(match => match[1]);
const data = { migrations: schemaMigrations, repair: [...SOURCE_REVISION_TENANT_REPAIR_STATEMENTS], stranded: STRANDED_SOURCE_REVISION_QUERY, extras, seeds: groups };
writeFileSync(process.argv[2] ?? new URL('schema.json', root), JSON.stringify(data, null, 2) + '\n');
db.close();
mock.timers.reset();
console.log(JSON.stringify({ migrations: data.migrations.length, repairs: data.repair.length, extras: extras.length, seed_counts: groups.map(group => group.rows.length) }));
