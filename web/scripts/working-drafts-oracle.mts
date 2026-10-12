import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SqliteDatabase, getDb } from '../apps/server/src/db/client.js';
import { AppRepository } from '../apps/server/src/db/repository.js';
import { PlanDraftWorkspaceService } from '../apps/server/src/services/plan-draft-workspace.js';
import { saveKitManifest } from '../apps/server/src/services/kit-manifest-store.js';
const [mode, root, shared] = process.argv.slice(2);
if (!mode || !root || !shared)
    throw Error('fixture arguments required');
if (process.env.LD_PRELOAD || process.env.DYLD_INSERT_LIBRARIES)
    throw Error('preloads rejected');
const database = new SqliteDatabase(root);
database.connect();
let token = 0;
const tokens: string[] = [];
const repo = new AppRepository(getDb(database), 'default', join(shared, 'repos'), undefined, { tokenFactory: () => { const value = `ppu_${(++token).toString(16).padStart(32, '0')}`; tokens.push(value); return value; } });
const service = new PlanDraftWorkspaceService(repo);
if (mode === 'seed') {
    const source = repo.createSource({ name: 'Ordinary Draft', url: 'https://example.test/ordinary-draft', source_kind: 'github' });
    const locator = `${source.id}/revisions/ordinary`;
    const path = join(shared, 'repos', locator);
    mkdirSync(path, { recursive: true });
    for (const [name, body] of Object.entries({ 'bracket_x2.stl': 'solid bracket\nendsolid bracket\n', '[a] cover.stl': 'solid cover\nendsolid cover\n', 'options/one/clip.stl': 'solid one\nendsolid one\n', 'options/two/clip.stl': 'solid two\nendsolid two\n' })) {
        mkdirSync(join(path, name, '..'), { recursive: true });
        writeFileSync(join(path, name), body);
    }
    writeFileSync(join(path, 'print-partner.manifest.yaml'), `project: Ordinary Draft\noption_groups:\n  clips:\n    rule: pick_one\n    min: 1\n    variants:\n      - id: one\n        parts: [options/one/*]\n      - id: two\n        parts: [options/two/*]\nselections:\n  clips: one\nparts:\n  - match: '*cover.stl'\n    requirement: cosmetic\n  - match: 'bracket*'\n    requirement: required\n`);
    const observed = repo.getProjectRow(source.id);
    if (!observed)
        throw Error('missing source');
    const revision = repo.recordSourceRevision({ sourceId: source.id, upstreamRevisionKey: 'ordinary', manifestDigest: 'a'.repeat(64), snapshotLocator: locator, syncedAt: new Date().toISOString(), completeness: 'complete' });
    repo.activateSourceRevision({ sourceId: source.id, revisionId: revision.id, observed, sourceVersion: 'ordinary' });
    const profile = repo.createProfile('Ordinary Working Draft', source.id);
    repo.setSetting(`role_filaments_${profile.id}`, JSON.stringify({ accent: { filament_custom_hex: '#ff8800' } }));
    saveKitManifest(repo, profile.id, { selections: { clips: 'two' } });
    const seeded = repo.recomputePlanDraft({ profileId: profile.id, actor: 'default', idempotencyKey: 'seed', applyManifest: true });
    if (seeded.kind !== 'created')
        throw Error(`seed ${seeded.kind}`);
    writeFileSync(join(shared, 'identities.json'), JSON.stringify({ profile: profile.id, source: source.id, draft: seeded.draft.id }));
    database.close();
    process.stdout.write(JSON.stringify({ kind: 'seeded', profile: profile.id, source: source.id, draft: seeded.draft.id }) + '\n');
}
else if (mode === 'augment') {
    const overlay = repo.createSource({ name: 'Overlay', url: 'https://example.test/overlay', source_kind: 'github' });
    const locator = `${overlay.id}/revisions/ordinary`;
    const pinned = join(shared, 'repos', locator);
    mkdirSync(pinned, { recursive: true });
    writeFileSync(join(pinned, 'bracket_x2.stl'), 'solid overlay\nendsolid overlay\n');
    const observed = repo.getProjectRow(overlay.id);
    if (!observed)
        throw Error('missing overlay');
    const revision = repo.recordSourceRevision({ sourceId: overlay.id, upstreamRevisionKey: 'ordinary', manifestDigest: 'b'.repeat(64), snapshotLocator: locator, syncedAt: new Date().toISOString(), completeness: 'complete' });
    repo.activateSourceRevision({ sourceId: overlay.id, revisionId: revision.id, observed, sourceVersion: 'ordinary' });
    const checkout = join(shared, 'overlay-checkout');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'print-partner.manifest.yaml'), `project: Overlay\nparts:\n  - match: 'bracket*'\n    requirement: optional\n`);
    repo.updateSource(overlay.id, { local_path: checkout });
    repo.addAddonLayer(1, overlay.id);
    const local = join(shared, 'local');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'Zéta:part.stl'), 'solid local\nendsolid local\n');
    const untracked = repo.createSource({ name: 'Local', source_kind: 'local', local_path: local });
    repo.addAddonLayer(1, untracked.id);
    writeFileSync(join(local, 'print-partner.manifest.yaml'), `project: Local\nshared: &rule\n  match: '*.stl'\n  requirement: optional\nparts: [*rule]\noption_groups: {}\n`);
    database.close();
    process.stdout.write(JSON.stringify({ kind: 'augmented', overlay: overlay.id, untracked: untracked.id }) + '\n');
}
else if (mode === 'ambiguity') {
    const source = repo.createSource({ name: 'Ambiguous ordinary', url: 'https://example.test/ordinary', source_kind: 'github' });
    for (const [generation, names] of [['first', ['left.stl', 'right.stl']], ['second', ['front.stl', 'rear.stl']]]) {
        const locator = `${source.id}/revisions/${generation}`;
        const path = join(shared, 'repos', locator);
        mkdirSync(path, { recursive: true });
        for (const name of names)
            writeFileSync(join(path, name), 'solid same\nendsolid same\n');
        const observed = repo.getProjectRow(source.id);
        if (!observed)
            throw Error('missing Source');
        const revision = repo.recordSourceRevision({ sourceId: source.id, upstreamRevisionKey: generation, manifestDigest: (generation === 'first' ? 'c' : 'd').repeat(64), snapshotLocator: locator, syncedAt: new Date().toISOString(), completeness: 'complete' });
        repo.activateSourceRevision({ sourceId: source.id, revisionId: revision.id, observed, sourceVersion: generation });
        if (generation === 'first') {
            const profile = repo.createProfile('Ambiguous ordinary', source.id);
            const outcome = service.recompute({ profileId: profile.id, actorId: 'default', idempotencyKey: 'baseline', applyManifest: true });
            if (outcome.kind !== 'ready')
                throw Error('baseline not ready');
            const draft = repo.getPlanDraft(profile.id, outcome.workspace.draft.draft_id);
            if (!draft)
                throw Error('missing baseline');
            repo.applyPlanChanges({ profileId: profile.id, draftId: draft.id, expectedSnapshotDigest: draft.snapshotDigest, expectedLifecycleVersion: draft.lifecycleVersion, expectedBase: { kind: 'empty', planVersion: 0 }, actorId: 'default', idempotencyKey: 'baseline' });
        }
    }
    database.close();
    process.stdout.write(JSON.stringify({ kind: 'ambiguity' }) + '\n');
}
else if (mode === 'metadata') {
    const fixture = join(shared, 'community.yaml');
    writeFileSync(fixture, `project: Overlay\nparts:\n  - match: 'bracket*'\n    requirement: cosmetic\n    option_group: community_group\n`);
    symlinkSync(fixture, join(process.cwd(), 'web/apps/server/src/data/manifests/working-draft-ordinary.yaml'));
    repo.updateSource(2, { manifest_community_slug: 'working-draft-ordinary' });
    writeFileSync(join(shared, 'local/print-partner.manifest.yaml'), `project: Local\nshared: &rule\n  match: '*.stl'\n  requirement: !!str optional\n  option_group: [.iNf, !!int "0b11", true, null]\nparts: [*rule]\noption_groups:\n  10: {rule: pick_any, label: true, parts: []}\n  2: {rule: pick_any, label: !!str false, parts: []}\nvariant_dimensions: {size: [small, 2, true]}\n`);
    repo.updateImportRules(1, ['bracket_x2.stl', '[a] cover.stl', 'options/two/']);
    database.close();
    process.stdout.write(JSON.stringify({ kind: 'metadata' }) + '\n');
}
else if (mode === 'naming') {
    const naming = repo.getGlobalNaming();
    repo.saveGlobalNaming({ ...naming, roles: naming.roles.map(role => ({ ...role, markers: role.id === 'primary' ? ['[a'] : role.markers })), folder_rules: [{ path_contains: 'options/one/', role_id: 'clear' }] });
    writeFileSync(join(shared, 'overlay-checkout/print-partner.manifest.yaml'), `project: Overlay\nparts:\n  - match: 'bracket*'\n    requirement: optional\noption_groups:\n  overlay:\n    rule: pick_one\n    variants:\n      - id: on\n        parts: ['bracket*']\n      - id: off\n        parts: ['absent*']\nselections: {overlay: off}\n`);
    database.close();
    process.stdout.write(JSON.stringify({ kind: 'naming' }) + '\n');
}
else if (mode === 'empty') {
    writeFileSync(join(shared, 'plain-file.txt'), 'ordinary non-directory');
    symlinkSync(join(shared, 'local'), join(shared, 'root-link'));
    const profiles = [];
    for (const [name, path] of [['Missing', join(shared, 'missing-root')], ['File', join(shared, 'plain-file.txt')], ['Link', join(shared, 'root-link')]]) {
        const source = repo.createSource({ name, source_kind: 'local', local_path: path });
        profiles.push(repo.createProfile(name, source.id).id);
    }
    profiles.push(repo.createProfile('No Source').id);
    database.close();
    process.stdout.write(JSON.stringify({ kind: 'empty', profiles }) + '\n');
}
else {
    process.stdout.write(JSON.stringify({ ready: true, tenant_id: "default", authentication: "injected catalog oracle" }) + '\n');
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
        try {
            const c = JSON.parse(line);
            const profileId = c.profile;
            const r = c.request;
            let result: unknown;
            if (c.action === 'full')
                result = repo.getPlanDraft(profileId, c.draft);
            else if (c.action === 'publish') {
                const d = repo.getPlanDraft(profileId, c.draft);
                if (!d)
                    throw Error('draft missing');
                result = repo.applyPlanChanges({ profileId, draftId: d.id, expectedSnapshotDigest: d.snapshotDigest, expectedLifecycleVersion: d.lifecycleVersion, expectedBase: d.baseRevisionId == null ? { kind: 'empty', planVersion: 0 } : { kind: 'revision', revisionId: d.baseRevisionId, planVersion: d.basePlanVersion }, actorId: 'default', idempotencyKey: c.key });
            }
            else if (r.kind === 'list')
                result = { kind: 'listed', drafts: repo.listPlanDraftIdentities(profileId) };
            else if (r.kind === 'read')
                result = { kind: 'read', draft: repo.getPlanDraft(profileId, r.draft_id) };
            else if (r.kind === 'diff')
                result = { kind: 'diff', diff: repo.diffPlanDraft(profileId, r.draft_id) };
            else if (r.kind === 'workspace')
                result = service.read(profileId, r.draft_id);
            else if (r.kind === 'recompute') {
                result = c.service ? service.recompute({ profileId, actorId: 'default', idempotencyKey: r.idempotency_key, applyManifest: r.options.apply_manifest }) : repo.recomputePlanDraft({ profileId, actor: 'default', idempotencyKey: r.idempotency_key, applyManifest: r.options.apply_manifest, preferAccepted: r.options.prefer_accepted, partChoicesBySourceId: r.options.part_choices_by_source_id ? new Map(Object.entries(r.options.part_choices_by_source_id).map(([k, v]) => [Number(k), new Map(Object.entries(v))])) : undefined, excludedPathsBySourceId: r.options.excluded_paths_by_source_id ? new Map(Object.entries(r.options.excluded_paths_by_source_id).map(([k, v]) => [Number(k), new Set(v as string[])])) : undefined, includedPathsBySourceId: r.options.included_paths_by_source_id ? new Map(Object.entries(r.options.included_paths_by_source_id).map(([k, v]) => [Number(k), new Set(v as string[])])) : undefined });
            }
            else if (r.kind === 'transition')
                result = repo.transitionPlanDraft({ profileId, draftId: r.draft_id, transition: { kind: r.transition, expectedLifecycleVersion: r.expected_lifecycle_version } });
            else if (r.kind === 'edit') {
                const decisions = r.decisions.map((d: Record<string, unknown>) => ({ kind: d.kind, partIds: d.draft_part_ids, value: d.value }));
                result = c.service ? service.editParts({ profileId, draftId: r.draft_id, actorId: 'default', request: { expected_snapshot_digest: r.expected_snapshot_digest, decisions: r.decisions } }) : repo.editPlanDraftPartsBatch({ profileId, draftId: r.draft_id, expectedSnapshotDigest: r.expected_snapshot_digest, decisions });
            }
            else if (r.kind === 'prepare_apply')
                result = service.prepareForApply({ profileId, draftId: r.draft_id, actorId: 'default', expected: r.expected ? { snapshotDigest: r.expected.snapshot_digest, lifecycleVersion: r.expected.lifecycle_version, base: r.expected.base } : undefined });
            else if (r.kind === 'select')
                result = service.reconcile({ profileId, draftId: r.draft_id, actorId: 'default', idempotencyKey: r.idempotency_key, request: r.request });
            else if (r.kind === 'rebase') {
                const q = r.request;
                result = repo.rebasePlanDraft({ profileId, sourceDraftId: q.source_draft_id, expectedSourceState: q.expected_source_state, expectedSourceLifecycleVersion: q.expected_source_lifecycle_version, expectedSourceSnapshotDigest: q.expected_source_snapshot_digest, actor: 'default', idempotencyKey: r.idempotency_key });
                if (c.service && (result.kind === 'rebased' || result.kind === 'existing'))
                    result = service.prepareForApply({ profileId, draftId: result.draft.id, actorId: 'default' });
            }
            else
                throw Error('unknown fixture operation');
            process.stdout.write(JSON.stringify({ ok: result }) + '\n');
        }
        catch (e) {
            process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) + '\n');
        }
    }
    database.close();
}

writeFileSync(join(root, "token-transcript.json"), JSON.stringify(tokens));
