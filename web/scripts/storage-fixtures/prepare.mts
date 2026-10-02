import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { SqliteDatabase, getDb } from '../../apps/server/src/db/client.js';
import { AppRepository } from '../../apps/server/src/db/repository.js';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const clock = '2026-10-02T00:00:00.000Z';
mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) });
const make = (directory) => { mkdirSync(directory, { recursive: true }); const db = new SqliteDatabase(directory); db.connect(); return db; };
const settings = (db) => {
    const a = new AppRepository(getDb(db), 'tenant-a', db.reposDir), b = new AppRepository(getDb(db), 'tenant-b', db.reposDir);
    a.setSetting('discord_notify_on_update', '1');
    b.setSetting('discord_notify_on_update', '0');
    a.setSetting('discord_notify_on_sync', '');
    a.compareAndSetSetting({ key: 'discord_notify_on_sync', expected: { kind: 'stored', value: '' }, value: '1' });
    a.compareAndSetSetting({ key: 'discord_notify_on_sync', expected: { kind: 'missing' }, value: 'wrong' });
};
const inputs = [];
const cases = [...[0, 31, 32, 33, 34].map(version => ({ version, name: version === 0 ? 'fresh' : `schema-${version}` })), { version: 34, name: 'immutable-corpus' }];
for (const { version, name } of cases) {
    const original = join(out, name, 'input'), expected = join(out, name, 'expected'), rust = join(out, name, 'rust');
    mkdirSync(original, { recursive: true });
    mkdirSync(expected, { recursive: true });
    mkdirSync(rust, { recursive: true });
    if (version !== 0) {
        const db = make(original);
        db.close();
        const raw = new Database(join(original, 'print-partner.db'));
        if (name === 'immutable-corpus') {
            const golden = JSON.parse(readFileSync(new URL('../../packages/contracts/test-fixtures/desktop/autosave-v1.json', import.meta.url), 'utf8'));
            const states = Object.entries(golden.normalized.states).filter(([_, state]) => state.database.accepted_plate_heads.length > 0).sort((a, b) => b[1].database.accepted_plate_revisions.length - a[1].database.accepted_plate_revisions.length);
            const [stateId, state] = states[0];
            const triggers = raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
            raw.pragma('foreign_keys=OFF');
            for (const trigger of triggers)
                raw.exec(`DROP TRIGGER "${trigger.name}"`);
            for (const [table, rows] of Object.entries(state.database)) {
                raw.exec(`DELETE FROM "${table}"`);
                for (const row of rows) {
                    const columns = Object.keys(row);
                    raw.prepare(`INSERT INTO "${table}"(${columns.map(column => `"${column}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
                }
            }
            for (const trigger of triggers)
                raw.exec(trigger.sql);
            raw.pragma('foreign_keys=ON');
            if (raw.pragma('foreign_key_check').length)
                throw new Error('Golden graph has broken foreign keys');
            writeFileSync(join(out, name, 'corpus-source.json'), JSON.stringify({ stateId, counts: Object.fromEntries(Object.entries(state.database).map(([table, rows]) => [table, rows.length])) }, null, 2));
        }
        else {
            raw.exec("INSERT INTO projects(id,tenant_id,name,url) VALUES(100,'tenant-claimed','Legacy Source','https://example.invalid/fixture'); INSERT INTO source_revisions(id,tenant_id,project_id,upstream_revision_key,manifest_digest,snapshot_locator,synced_at,completeness) VALUES(100,'default',100,'retained-key','retained-digest','100/revisions/retained','2026-01-01T00:00:00.000Z','complete'); UPDATE projects SET current_source_revision_id=100 WHERE id=100;");
            raw.prepare("INSERT INTO app_settings(tenant_id,key,value) VALUES('tenant-claimed','retained-empty','')").run();
        }
        if (version < 34)
            raw.exec('DROP TABLE board_comments; DROP TABLE board_posts;');
        if (version < 32)
            raw.exec('ALTER TABLE projects DROP COLUMN legacy_manifest_cutover;');
        raw.prepare("UPDATE app_settings SET value=? WHERE tenant_id='default' AND key='schema_version'").run(String(version));
        raw.close();
        for (const target of [expected, rust])
            copyFileSync(join(original, 'print-partner.db'), join(target, 'print-partner.db'));
    }
    const node = make(expected);
    settings(node);
    node.close();
    inputs.push({ name, version, original, expected, rust });
}
writeFileSync(join(out, 'fixtures.json'), JSON.stringify({ clock, inputs, node: process.version }, null, 2));
mock.timers.reset();
console.log(JSON.stringify({ fixtures: inputs.length, node_exited_before_rust: true }));
