import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SqliteDatabase, getDb } from '../apps/server/src/db/client.js';
import { AppRepository } from '../apps/server/src/db/repository.js';
import type { PlanChoiceChange } from '../apps/server/src/services/plan-save.js';
const [mode, root, shared, start] = process.argv.slice(2);
if (mode !== 'run' || !root || !shared) throw Error('fixture arguments required');
if (process.env.LD_PRELOAD || process.env.DYLD_INSERT_LIBRARIES) throw Error('preloads rejected');
const database = new SqliteDatabase(root);
database.connect();
let token = Number(start ?? 1000);
const tokens: string[] = [];
const repo = new AppRepository(getDb(database), 'default', join(shared, 'repos'), undefined, {
    tokenFactory: () => {
        const value = `ppu_${(++token).toString(16).padStart(32, '0')}`;
        tokens.push(value);
        return value;
    },
});
process.stdout.write(JSON.stringify({ ready: true, tenant_id: 'default', authentication: 'injected isolated repository oracle' }) + '\n');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
        const c = JSON.parse(line);
        const profileId = c.profile;
        let result: unknown;
        if (c.action === 'save') {
            const r = c.request;
            const base = r.expected_base;
            const draft = r.expected_draft;
            const changes: PlanChoiceChange[] = r.decisions.map((change: { kind: 'set_included' | 'set_quantity_override'; value: boolean | number | null; target: { part_key: string; relative_path: string; source_layer: string | null } }): PlanChoiceChange => {
                const target = { partKey: change.target.part_key, relativePath: change.target.relative_path, sourceLayer: change.target.source_layer };
                if (change.kind === 'set_included' && typeof change.value === 'boolean') return { kind: change.kind, value: change.value, target };
                if (change.kind === 'set_quantity_override' && (change.value === null || typeof change.value === 'number')) return { kind: change.kind, value: change.value, target };
                throw Error('invalid ordinary fixture choice');
            });
            result = repo.savePlanChoices({ profileId, actorId: 'default', idempotencyKey: c.key,
                expectedBase: base.revision_id == null ? { kind: 'empty', planVersion: base.plan_version } : { kind: 'revision', revisionId: base.revision_id, planVersion: base.plan_version },
                expectedDraft: draft ? { id: draft.draft_id, snapshotDigest: draft.snapshot_digest, lifecycleVersion: draft.lifecycle_version } : null,
                remapCheckoffLinks: r.remap_checkoff_links, changes });
        } else if (c.action === 'publish') {
            const d = repo.getPlanDraft(profileId, c.draft);
            if (!d) throw Error('draft missing');
            result = repo.applyPlanChanges({ profileId, draftId: d.id, expectedSnapshotDigest: d.snapshotDigest, expectedLifecycleVersion: d.lifecycleVersion, expectedBase: d.baseRevisionId == null ? { kind: 'empty', planVersion: 0 } : { kind: 'revision', revisionId: d.baseRevisionId, planVersion: d.basePlanVersion }, actorId: 'default', idempotencyKey: c.key });
        } else throw Error('unknown fixture operation');
        const captured = c.action === 'save' && typeof result === 'object' && result !== null && 'kind' in result && result.kind === 'saved' ? repo.readAcceptedPlanOperationalSnapshot(profileId) : undefined;
        process.stdout.write(JSON.stringify({ ok: result, captured_snapshot: captured }) + '\n');
    } catch (error) {
        process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
    }
}
database.close();
writeFileSync(join(root, 'token-transcript.json'), JSON.stringify(tokens));
