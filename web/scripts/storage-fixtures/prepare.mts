import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import { SqliteDatabase, getDb } from '../../apps/server/src/db/client.js';
import { AppRepository } from '../../apps/server/src/db/repository.js';
import { currentSchemaVersion } from '../../apps/server/src/db/schema.js';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Database = require('better-sqlite3');
if (process.version !== 'v22.23.3' || process.versions.modules !== '127')
    throw new Error(`storage fixtures require Node v22.23.3 ABI 127, found ${process.version} ABI ${process.versions.modules}`);
const out = process.argv[2];
if (!out)
    throw new Error('usage: prepare.mts OUTPUT_DIR');
if (currentSchemaVersion !== 34)
    throw new Error(`generated fixtures only describe manual edits of Node schema 34, found ${currentSchemaVersion}`);
mkdirSync(out, { recursive: true });
const clock = '2026-10-02T00:00:00.000Z';
mock.timers.enable({ apis: ['Date'], now: Date.parse(clock) });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const treeFiles = (directory) => {
    const files = [];
    const walk = (current) => {
        for (const entry of readdirSync(current)) {
            const path = join(current, entry);
            if (statSync(path).isDirectory())
                walk(path);
            else
                files.push(path);
        }
    };
    if (statSync(directory, { throwIfNoEntry: false })?.isDirectory())
        walk(directory);
    files.sort();
    return files.map(path => ({
        path: relative(directory, path).split('\\').join('/'),
        sha256: sha256(readFileSync(path)),
    }));
};
const provenance = (version, name) => {
    if (version === 0) {
        return {
            kind: 'generated-current-node',
            historicalSnapshot: false,
            sourceSchemaVersion: currentSchemaVersion,
            startingVersionStamp: 0,
            shapeGroup: 'empty-directory',
            transformations: ['node-connect-from-empty-directory'],
        };
    }
    const transformations = ['node-connect-current-schema'];
    let shapeGroup = name === 'immutable-corpus' ? 'generated-v34-current-autosave' : 'generated-v34-current';
    if (name === 'immutable-corpus')
        transformations.push('replace-rows-from-autosave-golden');
    else
        transformations.push('insert-tenant-claimed-project');
    if (version < 34) {
        transformations.push('drop-board-posts-and-board-comments');
        shapeGroup = 'generated-v34-minus-board-tables';
    }
    if (version < 32) {
        transformations.push('drop-projects-legacy-manifest-cutover');
        shapeGroup = 'generated-v34-minus-board-and-legacy-column';
    }
    transformations.push('stamp-schema-version');
    return {
        kind: 'generated-current-node',
        historicalSnapshot: false,
        sourceSchemaVersion: currentSchemaVersion,
        startingVersionStamp: version,
        shapeGroup,
        transformations,
    };
};
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
    const meta = provenance(version, name);
    if (meta.kind !== 'generated-current-node' || meta.historicalSnapshot !== false)
        throw new Error(`${name} cannot be labeled as a historical snapshot`);
    let raw = null;
    for (const step of meta.transformations) {
        if (step === 'node-connect-from-empty-directory')
            continue;
        if (step === 'node-connect-current-schema') {
            const db = make(original);
            db.close();
            raw = new Database(join(original, 'print-partner.db'));
            continue;
        }
        if (!raw)
            throw new Error(`${name} ran ${step} before the database existed`);
        if (step === 'replace-rows-from-autosave-golden') {
            const golden = JSON.parse(readFileSync(new URL('../../packages/contracts/test-fixtures/desktop/autosave-v1.json', import.meta.url), 'utf8'));
            const states = Object.entries(golden.normalized.states).filter(([, state]) => state.database.accepted_plate_heads.length > 0).sort((a, b) => b[1].database.accepted_plate_revisions.length - a[1].database.accepted_plate_revisions.length);
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
            continue;
        }
        if (step === 'insert-tenant-claimed-project') {
            raw.exec("INSERT INTO projects(id,tenant_id,name,url) VALUES(100,'tenant-claimed','Legacy Source','https://example.invalid/fixture'); INSERT INTO source_revisions(id,tenant_id,project_id,upstream_revision_key,manifest_digest,snapshot_locator,synced_at,completeness) VALUES(100,'default',100,'retained-key','retained-digest','100/revisions/retained','2026-01-01T00:00:00.000Z','complete'); UPDATE projects SET current_source_revision_id=100 WHERE id=100;");
            raw.prepare("INSERT INTO app_settings(tenant_id,key,value) VALUES('tenant-claimed','retained-empty','')").run();
            continue;
        }
        if (step === 'drop-board-posts-and-board-comments') {
            raw.exec('DROP TABLE board_comments; DROP TABLE board_posts;');
            continue;
        }
        if (step === 'drop-projects-legacy-manifest-cutover') {
            raw.exec('ALTER TABLE projects DROP COLUMN legacy_manifest_cutover;');
            continue;
        }
        if (step === 'stamp-schema-version') {
            raw.prepare("UPDATE app_settings SET value=? WHERE tenant_id='default' AND key='schema_version'").run(String(version));
            continue;
        }
        throw new Error(`${name} has unknown transformation ${step}`);
    }
    if (raw)
        raw.close();
    if (version !== 0) {
        for (const target of [expected, rust])
            copyFileSync(join(original, 'print-partner.db'), join(target, 'print-partner.db'));
    }
    const node = make(expected);
    settings(node);
    node.close();
    inputs.push({
        name,
        version,
        original,
        expected,
        rust,
        ...meta,
        rustFiles: treeFiles(rust),
        expectedFiles: treeFiles(expected),
    });
}
const shared = inputs.filter(input => input.shapeGroup === 'generated-v34-minus-board-tables');
const sharedNames = shared.map(input => input.name);
if (sharedNames.join(',') !== 'schema-32,schema-33')
    throw new Error(`shared generated shape cases were ${sharedNames.join(',')}`);
const expectedTreesEqual = JSON.stringify(shared[0].expectedFiles) === JSON.stringify(shared[1].expectedFiles);
if (!expectedTreesEqual)
    throw new Error('schema-32 and schema-33 expected trees diverged after Node connect to schema 34');
const generatorSha256 = sha256(readFileSync(fileURLToPath(new URL('./prepare.mts', import.meta.url))));
const nodeSha256 = sha256(readFileSync(process.execPath));
const cacheMaterial = [
    generatorSha256,
    process.version,
    process.versions.modules,
    String(currentSchemaVersion),
    nodeSha256,
    clock,
    ...inputs.map(input => [
        input.name,
        input.kind,
        String(input.historicalSnapshot),
        input.shapeGroup,
        String(input.startingVersionStamp),
        input.transformations.join(','),
    ].join('\t')),
].join('\n') + '\n';
writeFileSync(join(out, 'fixtures.json'), JSON.stringify({
    clock,
    contract: 'generated-fixture-compatibility',
    historicalSnapshot: false,
    sourceSchemaVersion: currentSchemaVersion,
    node: process.version,
    abi: process.versions.modules,
    nodeSha256,
    generatorPath: 'scripts/storage-fixtures/prepare.mts',
    generatorSha256,
    cacheKey: sha256(cacheMaterial),
    sameGeneratedShape: {
        shapeGroup: 'generated-v34-minus-board-tables',
        names: sharedNames,
        expectedTreesEqual,
    },
    inputs,
}, null, 2));
mock.timers.reset();
console.log(JSON.stringify({ fixtures: inputs.length, node_exited_before_rust: true, contract: 'generated-fixture-compatibility' }));
