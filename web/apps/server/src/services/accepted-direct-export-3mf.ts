import { createHash } from "node:crypto";
import { encodeAcceptedPlate3mf, safePlanSlug } from "@print-partner/domain";
import type { AcceptedPlanBasis } from "../db/accepted-plan-progress.js";
import { acceptedPlanBasis } from "../db/accepted-plan-progress.js";
import type { AppRepository } from "../db/repository.js";
import { writeAcceptedExportFile } from "./accepted-export-publication.js";
import {
  loadAcceptedArtifactGeometry,
  type AcceptedArtifactGeometryLimit,
} from "./accepted-artifact-geometry.js";
import { ACCEPTED_PART_MESH_MAX_BYTES } from "./accepted-part-media.js";
import { parseRequiredUnitToken, type RequiredUnitToken } from "./required-units.js";
import type { AcceptedOperationalArtifact } from "../db/accepted-plan-operational.js";

export const DIRECT_EXPORT_3MF_LIMITS = {
  maxArtifactBytes: ACCEPTED_PART_MESH_MAX_BYTES,
  maxTotalSourceBytes: 256 * 1024 * 1024,
  maxObjects: 10_000,
  maxTriangles: 5_000_000,
  maxOutputBytes: 512 * 1024 * 1024,
} as const;

export type MaterializeDirectExport3mfCommand = Readonly<{
  profileId: number;
  tokens: readonly string[];
}>;

export type MaterializedDirectExport3mf = Readonly<{
  kind: "materialized";
  basis: AcceptedPlanBasis;
  filename: string;
  absolutePath: string;
  tokens: readonly RequiredUnitToken[];
}>;

export type MaterializeDirectExport3mfResult =
  | MaterializedDirectExport3mf
  | { readonly kind: "profile_not_found" }
  | { readonly kind: "empty_plan" }
  | { readonly kind: "accepted_state_unavailable"; readonly reason: "compatibility_dirty" | "uninitialized" }
  | { readonly kind: "unknown_token"; readonly token: string }
  | {
      readonly kind: "artifact_unavailable";
      readonly token: RequiredUnitToken;
      readonly reason: string;
    }
  | { readonly kind: "invalid_stl"; readonly token: RequiredUnitToken }
  | { readonly kind: "artifact_geometry_mismatch"; readonly token: RequiredUnitToken }
  | { readonly kind: "limit_exceeded"; readonly limit: AcceptedArtifactGeometryLimit | "output_bytes" }
  | { readonly kind: "output_failure" };

export type MaterializeDirectExport3mfDependencies = Readonly<{
  repository: Pick<AppRepository, "getOwnedProfileIdentity" | "readAcceptedPlanOperationalSnapshot">;
  reposDir: string;
  tenantExportsDir: string;
  limits?: typeof DIRECT_EXPORT_3MF_LIMITS;
}>;

type SelectedUnit = Readonly<{
  token: RequiredUnitToken;
  objectName: string;
  artifact: AcceptedOperationalArtifact;
}>;

function uniqueTokens(values: readonly string[]): RequiredUnitToken[] | { token: string } {
  const tokens: RequiredUnitToken[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let token: RequiredUnitToken;
    try {
      token = parseRequiredUnitToken(value);
    } catch {
      return { token: value };
    }
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

export async function materializeDirectExport3mf(
  dependencies: MaterializeDirectExport3mfDependencies,
  command: MaterializeDirectExport3mfCommand,
): Promise<MaterializeDirectExport3mfResult> {
  const limits = dependencies.limits ?? DIRECT_EXPORT_3MF_LIMITS;
  const profile = dependencies.repository.getOwnedProfileIdentity(command.profileId);
  if (!profile) return { kind: "profile_not_found" };
  const requested = uniqueTokens(command.tokens);
  if (!Array.isArray(requested) || requested.length === 0) {
    return { kind: "unknown_token", token: Array.isArray(requested) ? "" : requested.token };
  }

  const accepted = dependencies.repository.readAcceptedPlanOperationalSnapshot(command.profileId);
  if (accepted.kind === "empty") return { kind: "empty_plan" };
  if (accepted.kind !== "ready") {
    return { kind: "accepted_state_unavailable", reason: accepted.kind };
  }

  const available = new Map<string, SelectedUnit>();
  for (const part of accepted.snapshot.parts) {
    if (!part.included) continue;
    for (const unit of part.units) {
      if (!unit.required) continue;
      const token = parseRequiredUnitToken(unit.token);
      available.set(token, {
        token,
        objectName: unit.objectName,
        artifact: part.artifact,
      });
    }
  }

  const selected: SelectedUnit[] = [];
  for (const token of requested) {
    const unit = available.get(token);
    if (!unit) return { kind: "unknown_token", token };
    selected.push(unit);
  }

  const loaded = await loadAcceptedArtifactGeometry({
    reposDir: dependencies.reposDir,
    units: selected,
    limits,
  });
  if (loaded.kind === "degenerate_geometry") {
    return { kind: "artifact_geometry_mismatch", token: loaded.token };
  }
  if (loaded.kind !== "ready") return loaded;

  const bytes = encodeAcceptedPlate3mf(selected.map((unit) => {
    const geometry = loaded.geometryByToken.get(unit.token);
    if (!geometry) throw new Error("Direct export mesh is missing");
    return {
      token: unit.token,
      objectName: unit.objectName,
      xUm: 0,
      yUm: 0,
      mesh: geometry.mesh,
    };
  }));
  if (bytes.byteLength > limits.maxOutputBytes) {
    return { kind: "limit_exceeded", limit: "output_bytes" };
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  const filename = `direct-${digest.slice(0, 16)}.3mf`;
  try {
    const absolutePath = writeAcceptedExportFile({
      root: dependencies.tenantExportsDir,
      directorySegments: [
        `profile-${profile.id}-${safePlanSlug(profile.name).slice(0, 80)}`,
        "direct-3mf",
      ],
      filename,
      bytes,
    });
    return {
      kind: "materialized",
      basis: acceptedPlanBasis(accepted.snapshot),
      filename,
      absolutePath,
      tokens: selected.map((unit) => unit.token),
    };
  } catch {
    return { kind: "output_failure" };
  }
}
