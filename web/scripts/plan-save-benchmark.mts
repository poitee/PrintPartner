import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { parsePlanDraftWorkspace } from "@print-partner/contracts";
import { buildApp } from "../apps/server/src/app.js";
import { loadConfig } from "../apps/server/src/config.js";
import { createSelfHostPorts } from "../apps/server/src/adapters/self-host/index.js";
import { PlanDraftWorkspaceService } from "../apps/server/src/services/plan-draft-workspace.js";
import type { AcceptedPlanReviewBody } from "../apps/server/src/services/accepted-plan-review.js";

const root = mkdtempSync(join(tmpdir(), "pp-autosave-benchmark-"));
const ports = createSelfHostPorts(root);
await ports.db.connect();
const repo = ports.repository;
repo.setSetting("source_update_check_hours", "0");
const sources = [];
for (let layer = 0; layer < 7; layer += 1) {
  const source = repo.createSource({ name: `Benchmark source ${layer + 1}`, url: `https://example.test/benchmark-${layer}`, source_kind: "github" });
  const observed = repo.getProjectRow(source.id);
  if (!observed) throw new Error("Benchmark source missing");
  const locator = `${source.id}/revisions/benchmark`;
  const snapshotRoot = join(root, "repos", locator);
  for (let index = 0; index < 50; index += 1) {
    const folder = join(snapshotRoot, `Folder-${Math.floor(index / 10)}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `part-${layer}-${index}.stl`), `solid part-${layer}-${index}\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 20 0 0\nvertex 0 20 0\nendloop\nendfacet\nendsolid\n`);
  }
  const revision = repo.recordSourceRevision({ sourceId: source.id, upstreamRevisionKey: "benchmark", manifestDigest: "a".repeat(64),
    snapshotLocator: locator, syncedAt: new Date().toISOString(), completeness: "complete" });
  repo.activateSourceRevision({ sourceId: source.id, revisionId: revision.id, observed, sourceVersion: "benchmark" });
  sources.push(source);
}
const mainSource = sources[0];
if (!mainSource) throw new Error("Benchmark requires a source");
const profile = repo.createProfile("Autosave benchmark — 350 files", mainSource.id);
for (const source of sources.slice(1)) repo.addAddonLayer(profile.id, source.id);
const service = new PlanDraftWorkspaceService(repo);
const prepared = service.recompute({ profileId: profile.id, actorId: "benchmark", idempotencyKey: randomUUID(), applyManifest: false });
if (prepared.kind !== "ready") throw new Error(`Benchmark preparation failed: ${prepared.kind}`);
const selected = service.editParts({
  profileId: profile.id, draftId: prepared.workspace.draft.draft_id, actorId: "benchmark",
  request: { expected_snapshot_digest: prepared.workspace.draft.snapshot_digest, decisions: [{
    kind: "set_included", draft_part_ids: prepared.workspace.parts.map((part) => part.draft_part_id), value: true,
  }] },
});
if (selected.kind !== "ready") throw new Error(`Benchmark selection failed: ${selected.kind}`);
const draft = selected.workspace.draft;
const accepted = service.apply({ profileId: profile.id, draftId: draft.draft_id, actorId: "benchmark", idempotencyKey: randomUUID(), request: {
  expected_base: draft.base, expected_lifecycle_version: draft.lifecycle_version, expected_snapshot_digest: draft.snapshot_digest,
} });
if (accepted.kind !== "applied") throw new Error(`Benchmark acceptance failed: ${accepted.kind}`);
const config = { ...loadConfig(), dataDir: root, deployMode: "self-host" as const, multiUser: false,
  singleUserAuth: false, authRequired: false, basicUser: null, basicPass: null, saasBasicAuth: null };
const app = await buildApp(config, ports);

async function request<T = unknown>(method: "GET" | "POST" | "PATCH", path: string, payload?: object): Promise<T> {
  const result = await app.inject({ method, url: `/plans/${profile.id}${path}`, headers: { "idempotency-key": randomUUID() }, ...(payload ? { payload } : {}) });
  if (result.statusCode !== 200) throw new Error(`${method} ${path}: ${result.statusCode} ${result.body}`);
  return result.json<T>();
}

if (process.argv.includes("--serve")) {
  await app.listen({ host: "127.0.0.1", port: 5182 });
  console.log(JSON.stringify({ kind: "isolated-preview", root, profileId: profile.id, url: "http://127.0.0.1:5182", files: 350 }));
  const stop = async () => { await app.close(); await ports.db.close(); process.exit(0); };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
} else {
  const profiler = process.argv.includes("--profile") ? new Session() : null;
  let profiling = false;
  try {
    let review = await request<AcceptedPlanReviewBody>("GET", "/review?include_excluded=true");
    if (review.totals.included_parts !== 350) throw new Error("Benchmark must start with all 350 files selected");
    if (profiler) {
      profiler.connect();
      await profiler.post("Profiler.enable");
      await profiler.post("Profiler.start");
      profiling = true;
    }
    const modes = process.argv.includes("--single-request-only") ? ["single-request"] : ["existing", "single-request"];
    for (const mode of modes) {
      for (const count of [1, 10]) {
        const durations: number[] = [];
        for (let index = 0; index < 30; index += 1) {
          const targets = review.part_groups.flatMap((group) => group.parts).slice(0, count);
          if (!review.accepted_basis || targets.length !== count) throw new Error("Benchmark Plan targets missing");
          const included = index % 2 !== 0;
          const started = performance.now();
          if (mode === "single-request") {
            const saved = await request<{ review: AcceptedPlanReviewBody }>("POST", "/save", {
              expected_base: { revision_id: review.accepted_basis.plan_revision_id, plan_version: review.accepted_basis.plan_version },
              expected_draft: null, remap_checkoff_links: true,
              decisions: targets.map((part) => ({ kind: "set_included", target: {
                part_key: part.match_key, relative_path: part.relative_path, source_layer: part.source_layer,
              }, value: included })),
            });
            review = saved.review;
          } else {
            await request("GET", "/drafts");
            const before = parsePlanDraftWorkspace(await request("POST", "/drafts/recompute", { apply_manifest: false }));
            const edited = parsePlanDraftWorkspace(await request("PATCH", `/drafts/${before.draft.draft_id}/parts`, {
              expected_snapshot_digest: before.draft.snapshot_digest,
              decisions: targets.map((target) => {
                const part = before.parts.find((row) => row.part_key === target.match_key);
                if (!part) throw new Error("Benchmark target missing");
                return { kind: "set_included", draft_part_ids: [part.draft_part_id], value: included };
              }),
            }));
            await request("POST", `/drafts/${edited.draft.draft_id}/apply`, {
              expected_base: edited.draft.base, expected_snapshot_digest: edited.draft.snapshot_digest,
              expected_lifecycle_version: edited.draft.lifecycle_version, remap_checkoff_links: true,
            });
            const [, full] = await Promise.all([request("GET", "/review"), request<AcceptedPlanReviewBody>("GET", "/review?include_excluded=true"), request("GET", ""), request("GET", "/workflow"), request("GET", "/drafts")]);
            review = full;
          }
          durations.push(performance.now() - started);
          const confirmed = new Map(review.part_groups.flatMap((group) => group.parts).map((part) => [part.match_key, part]));
          if (targets.some((part) => confirmed.get(part.match_key)?.included !== included)) {
            throw new Error("Save response did not preserve the requested choices");
          }
        }
        durations.sort((a, b) => a - b);
        const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
        console.log(JSON.stringify({ kind: "save-benchmark", mode, filesPerEdit: count, samples: durations.length,
          p50Ms: durations[Math.floor(durations.length / 2)], p95Ms: p95, maxMs: durations.at(-1), root }));
        if (mode === "single-request" && (p95 == null || p95 >= 2000)) process.exitCode = 1;
      }
    }
  } finally {
    try {
      if (profiler && profiling) {
        const { profile: cpuProfile } = await profiler.post("Profiler.stop");
        const path = join(root, "save.cpuprofile");
        writeFileSync(path, JSON.stringify(cpuProfile));
        console.log(JSON.stringify({ kind: "save-cpu-profile", path }));
      }
    } finally {
      profiler?.disconnect();
      await app.close(); await ports.db.close();
    }
  }
}
