import type { FastifyInstance } from "fastify";
import type { AppRepository, SlicerInstanceRow } from "../db/repository.js";
import type {
  SlicerDialect,
  SlicerInstanceKind,
} from "../services/slicer-instances.js";
import { validateSlicerGuiUrl } from "../services/slicer-instances.js";
import { reloadManagedProfileSync } from "../services/profile-sync-manager.js";
import {
  createDockerAdapterForSpec,
  createFakeDockerAdapter,
  specFromInstanceRow,
  type SlicerDockerAdapter,
  type SlicerDockerStatus,
} from "../services/slicer-docker.js";
import { dockerPresetsForKind } from "../services/slicer-docker-presets.js";

type RouteDeps = {
  repo: AppRepository;
  deployMode?: "self-host" | "saas";
  /** Injected for tests; production resolves per instance target. */
  docker?: SlicerDockerAdapter;
};

const KINDS: ReadonlySet<string> = new Set(["orca", "prusa", "bambu", "custom"]);
const DIALECTS: ReadonlySet<string> = new Set(["orca_json", "bambu_json", "prusa_ini"]);

function asInstanceJson(row: SlicerInstanceRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    dialect: row.dialect,
    gui_url: row.guiUrl,
    watch_path: row.watchPath,
    docker_target: row.dockerTarget,
    docker_host: row.dockerHost,
    compose_service: row.composeService,
    image: row.image,
    container_name: row.containerName,
    ports_json: row.portsJson,
    volumes_json: row.volumesJson,
    env_json: row.envJson,
    status_cache: row.statusCache,
    status_message: row.statusMessage,
    enabled: row.enabled,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function parseKind(value: unknown): SlicerInstanceKind | null {
  if (typeof value !== "string" || !KINDS.has(value)) return null;
  return value as SlicerInstanceKind;
}

function parseDialect(value: unknown): SlicerDialect | null {
  if (typeof value !== "string" || !DIALECTS.has(value)) return null;
  return value as SlicerDialect;
}

function parseOptionalBoolean(
  value: unknown,
): { ok: true; value: boolean | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === "boolean") return { ok: true, value };
  return { ok: false };
}

function validateWritable(input: {
  kind: SlicerInstanceKind;
  dialect: SlicerDialect;
  watchPath: string;
  enabled: boolean;
}): string | null {
  if (input.kind === "custom" && input.enabled && !input.watchPath.trim()) {
    return "Custom slicer instances require watch_path when enabled";
  }
  if (input.kind === "custom" && !input.dialect) {
    return "Custom slicer instances require dialect";
  }
  return null;
}

function defaultDialectForKind(kind: SlicerInstanceKind): SlicerDialect {
  if (kind === "prusa") return "prusa_ini";
  if (kind === "bambu") return "bambu_json";
  return "orca_json";
}

function afterWatcherAffectingChange(): void {
  reloadManagedProfileSync();
}

function resolveDocker(deps: RouteDeps, row: SlicerInstanceRow): SlicerDockerAdapter {
  if (deps.docker) return deps.docker;
  return createDockerAdapterForSpec(specFromInstanceRow(row));
}

function persistStatus(repo: AppRepository, row: SlicerInstanceRow, status: SlicerDockerStatus) {
  return repo.upsertSlicerInstance({
    id: row.id,
    name: row.name,
    kind: row.kind,
    dialect: row.dialect,
    guiUrl: row.guiUrl,
    watchPath: row.watchPath,
    enabled: row.enabled,
    image: row.image,
    containerName: row.containerName,
    composeService: row.composeService,
    dockerTarget: row.dockerTarget,
    dockerHost: row.dockerHost,
    portsJson: row.portsJson,
    volumesJson: row.volumesJson,
    envJson: row.envJson,
    statusCache: status.state,
    statusMessage: status.message,
  });
}

function asStatusJson(row: SlicerInstanceRow, status: SlicerDockerStatus) {
  return {
    instance: asInstanceJson(row),
    status: {
      state: status.state,
      message: status.message,
      container_id: status.containerId,
    },
  };
}

export async function registerSlicerInstanceRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const deployMode = deps.deployMode ?? "self-host";

  app.get("/slicer-instances", async () => ({
    instances: deps.repo.listSlicerInstances().map(asInstanceJson),
  }));

  app.post("/slicer-instances/seed-defaults", async () => {
    const inserted = deps.repo.seedStockSlicerInstancesIfEmpty();
    if (inserted > 0) afterWatcherAffectingChange();
    return {
      inserted,
      instances: deps.repo.listSlicerInstances().map(asInstanceJson),
    };
  });

  app.post("/slicer-instances", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const kind = parseKind(body.kind);
    if (!name) return reply.status(400).send({ detail: "name is required" });
    if (!kind) return reply.status(400).send({ detail: "invalid kind" });

    const dialect =
      parseDialect(body.dialect) ?? (kind === "custom" ? null : defaultDialectForKind(kind));
    if (!dialect) return reply.status(400).send({ detail: "invalid or missing dialect" });

    const guiUrl = typeof body.gui_url === "string" ? body.gui_url.trim() : "";
    const watchPath = typeof body.watch_path === "string" ? body.watch_path.trim() : "";
    const guiErr = validateSlicerGuiUrl(guiUrl);
    if (guiErr) return reply.status(400).send({ detail: guiErr });
    const enabledParsed = parseOptionalBoolean(body.enabled);
    if (!enabledParsed.ok) {
      return reply.status(400).send({ detail: "enabled must be a boolean" });
    }
    const enabled = enabledParsed.value ?? true;

    const err = validateWritable({ kind, dialect, watchPath, enabled });
    if (err) return reply.status(400).send({ detail: err });

    const dockerDefaults = kind === "custom" ? null : dockerPresetsForKind(kind);

    const row = deps.repo.upsertSlicerInstance({
      name,
      kind,
      dialect,
      guiUrl,
      watchPath,
      enabled,
      image:
        typeof body.image === "string"
          ? body.image.trim() || null
          : (dockerDefaults?.image || null),
      containerName:
        typeof body.container_name === "string"
          ? body.container_name.trim() || null
          : (dockerDefaults?.container_name ?? null),
      composeService:
        typeof body.compose_service === "string"
          ? body.compose_service.trim() || null
          : (dockerDefaults?.compose_service ?? null),
      dockerTarget:
        typeof body.docker_target === "string"
          ? body.docker_target
          : (dockerDefaults ? "pp_compose" : "local"),
      dockerHost: typeof body.docker_host === "string" ? body.docker_host.trim() || null : null,
      portsJson:
        typeof body.ports_json === "string" ? body.ports_json : (dockerDefaults?.ports_json ?? "[]"),
      volumesJson:
        typeof body.volumes_json === "string"
          ? body.volumes_json
          : (dockerDefaults?.volumes_json ?? "[]"),
      envJson: typeof body.env_json === "string" ? body.env_json : (dockerDefaults?.env_json ?? "{}"),
    });
    afterWatcherAffectingChange();
    return reply.status(201).send(asInstanceJson(row));
  });

  app.put("/slicer-instances/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = deps.repo.getSlicerInstance(id);
    if (!existing) return reply.status(404).send({ detail: "Slicer instance not found" });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const name =
      typeof body.name === "string" ? body.name.trim() : existing.name;
    if (!name) return reply.status(400).send({ detail: "name is required" });

    const kind = body.kind !== undefined ? parseKind(body.kind) : (existing.kind as SlicerInstanceKind);
    if (!kind) return reply.status(400).send({ detail: "invalid kind" });

    const dialect =
      body.dialect !== undefined
        ? parseDialect(body.dialect)
        : (existing.dialect as SlicerDialect);
    if (!dialect) return reply.status(400).send({ detail: "invalid dialect" });

    const guiUrl =
      typeof body.gui_url === "string" ? body.gui_url.trim() : existing.guiUrl;
    const watchPath =
      typeof body.watch_path === "string" ? body.watch_path.trim() : existing.watchPath;
    if (typeof body.gui_url === "string") {
      const guiErr = validateSlicerGuiUrl(guiUrl);
      if (guiErr) return reply.status(400).send({ detail: guiErr });
    }
    const enabledParsed = parseOptionalBoolean(body.enabled);
    if (!enabledParsed.ok) {
      return reply.status(400).send({ detail: "enabled must be a boolean" });
    }
    const enabled = enabledParsed.value ?? existing.enabled;

    const err = validateWritable({ kind, dialect, watchPath, enabled });
    if (err) return reply.status(400).send({ detail: err });

    const row = deps.repo.upsertSlicerInstance({
      id,
      name,
      kind,
      dialect,
      guiUrl,
      watchPath,
      enabled,
      image: typeof body.image === "string" ? body.image.trim() || null : existing.image,
      containerName:
        typeof body.container_name === "string"
          ? body.container_name.trim() || null
          : existing.containerName,
      composeService:
        typeof body.compose_service === "string"
          ? body.compose_service.trim() || null
          : existing.composeService,
      dockerTarget:
        typeof body.docker_target === "string" ? body.docker_target : existing.dockerTarget,
      dockerHost:
        typeof body.docker_host === "string"
          ? body.docker_host.trim() || null
          : existing.dockerHost,
      portsJson: typeof body.ports_json === "string" ? body.ports_json : existing.portsJson,
      volumesJson:
        typeof body.volumes_json === "string" ? body.volumes_json : existing.volumesJson,
      envJson: typeof body.env_json === "string" ? body.env_json : existing.envJson,
    });
    afterWatcherAffectingChange();
    return asInstanceJson(row);
  });

  app.delete("/slicer-instances/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!deps.repo.deleteSlicerInstance(id)) {
      return reply.status(404).send({ detail: "Slicer instance not found" });
    }
    afterWatcherAffectingChange();
    return reply.status(204).send();
  });

  function assertDockerAllowed(reply: {
    status: (code: number) => { send: (body: unknown) => unknown };
  }): boolean {
    if (deployMode !== "saas") return true;
    reply.status(403).send({ detail: "Docker management disabled in saas mode" });
    return false;
  }

  app.get("/slicer-instances/:id/docker-status", async (request, reply) => {
    if (!assertDockerAllowed(reply)) return;
    const { id } = request.params as { id: string };
    const existing = deps.repo.getSlicerInstance(id);
    if (!existing) return reply.status(404).send({ detail: "Slicer instance not found" });
    const status = await resolveDocker(deps, existing).refreshStatus(specFromInstanceRow(existing));
    const row = persistStatus(deps.repo, existing, status);
    return asStatusJson(row, status);
  });

  app.post("/slicer-instances/:id/docker-pull", async (request, reply) => {
    if (!assertDockerAllowed(reply)) return;
    const { id } = request.params as { id: string };
    const existing = deps.repo.getSlicerInstance(id);
    if (!existing) return reply.status(404).send({ detail: "Slicer instance not found" });
    if (!existing.image?.trim()) {
      return reply.status(400).send({ detail: "image is required before pull" });
    }
    const status = await resolveDocker(deps, existing).pull(specFromInstanceRow(existing));
    const row = persistStatus(deps.repo, existing, status);
    return asStatusJson(row, status);
  });

  app.post("/slicer-instances/:id/docker-start", async (request, reply) => {
    if (!assertDockerAllowed(reply)) return;
    const { id } = request.params as { id: string };
    const existing = deps.repo.getSlicerInstance(id);
    if (!existing) return reply.status(404).send({ detail: "Slicer instance not found" });
    if (!existing.image?.trim()) {
      return reply.status(400).send({ detail: "image is required before start" });
    }
    if (existing.dockerTarget === "pp_compose" && !existing.composeService?.trim()) {
      return reply.status(400).send({ detail: "compose_service is required for pp_compose" });
    }
    const status = await resolveDocker(deps, existing).start(specFromInstanceRow(existing));
    const row = persistStatus(deps.repo, existing, status);
    return asStatusJson(row, status);
  });

  app.post("/slicer-instances/:id/docker-stop", async (request, reply) => {
    if (!assertDockerAllowed(reply)) return;
    const { id } = request.params as { id: string };
    const existing = deps.repo.getSlicerInstance(id);
    if (!existing) return reply.status(404).send({ detail: "Slicer instance not found" });
    const status = await resolveDocker(deps, existing).stop(specFromInstanceRow(existing));
    const row = persistStatus(deps.repo, existing, status);
    return asStatusJson(row, status);
  });

  app.get("/slicer-instances/:id/docker-logs", async (request, reply) => {
    if (!assertDockerAllowed(reply)) return;
    const { id } = request.params as { id: string };
    const existing = deps.repo.getSlicerInstance(id);
    if (!existing) return reply.status(404).send({ detail: "Slicer instance not found" });
    const query = request.query as { tail?: string };
    const tail = Number(query.tail ?? 200);
    const { lines } = await resolveDocker(deps, existing).logs(specFromInstanceRow(existing), {
      tail: Number.isFinite(tail) ? tail : 200,
    });
    return { lines };
  });
}

/** Test helper re-export. */
export { createFakeDockerAdapter };
