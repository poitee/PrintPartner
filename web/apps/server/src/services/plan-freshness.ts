import { createHash } from "node:crypto";
import type {
  PlanFreshness,
  PlanRevisionInput,
  PlanStaleReason,
  PlanUntrackedReason,
} from "@print-partner/contracts";
import type { StlNamingProfileDict } from "@print-partner/domain";

export type CurrentPlanInput = PlanRevisionInput & {
  readonly source_name: string;
};

export type AcceptedPlanInputIdentity = {
  readonly id: number;
  readonly accepted_at: string;
  readonly format_version: number;
  readonly inputs: readonly PlanRevisionInput[];
};

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function digestEffectiveNaming(profile: StlNamingProfileDict): string {
  return sha256({
    version: 1,
    roles: profile.roles.map((role) => ({
      id: role.id,
      label: role.label,
      markers: [...role.markers],
    })),
    quantity: {
      regex: profile.quantity.regex,
      default: profile.quantity.default,
    },
    slug: {
      strip_markers: profile.slug.strip_markers,
      strip_quantity: profile.slug.strip_quantity,
    },
    folder_rules: profile.folder_rules.map((rule) => ({
      path_contains: rule.path_contains,
      role_id: rule.role_id,
      functional_class: rule.functional_class ?? null,
    })),
    export_role_order: [...profile.export_role_order],
  });
}

export function canonicalPlanInputs(
  inputs: readonly PlanRevisionInput[],
): PlanRevisionInput[] {
  return [...inputs].sort((left, right) => left.source_id - right.source_id);
}

export function digestPlanInputs(inputs: readonly PlanRevisionInput[]): string {
  return sha256({ version: 2, inputs: canonicalPlanInputs(inputs) });
}

function nonEmpty<T>(items: readonly T[]): readonly [T, ...T[]] | null {
  const [first, ...rest] = items;
  return first === undefined ? null : [first, ...rest];
}

export function evaluatePlanFreshness(input: {
  accepted: AcceptedPlanInputIdentity | null;
  current: readonly CurrentPlanInput[];
  configurationChanged: boolean;
  inputsInvalid?: boolean;
}): PlanFreshness {
  if (!input.accepted || input.accepted.format_version !== 2) {
    return {
      status: "untracked",
      accepted_input_set_id: input.accepted?.id ?? null,
      accepted_at: input.accepted?.accepted_at ?? null,
      reasons: [{ kind: "no_accepted_inputs" }],
    };
  }

  const currentBySource = new Map(input.current.map((item) => [item.source_id, item]));
  const acceptedBySource = new Map(
    input.accepted.inputs.map((item) => [item.source_id, item]),
  );
  const staleReasons: PlanStaleReason[] = [];
  const untrackedReasons: PlanUntrackedReason[] = [];

  if (input.inputsInvalid) {
    staleReasons.push({ kind: "plan_inputs_invalid" });
  }

  if (
    input.configurationChanged ||
    acceptedBySource.size !== currentBySource.size ||
    [...acceptedBySource.keys()].some((sourceId) => !currentBySource.has(sourceId))
  ) {
    staleReasons.push({ kind: "plan_configuration_changed" });
  }

  for (const accepted of acceptedBySource.values()) {
    const current = currentBySource.get(accepted.source_id);
    if (!current) continue;
    if (accepted.tracking_kind === "untracked") {
      untrackedReasons.push({
        kind: "source_revision_untracked",
        source_id: accepted.source_id,
        source_name: current.source_name,
      });
    } else if (accepted.source_revision_id == null) {
      untrackedReasons.push({
        kind: "source_revision_untracked",
        source_id: accepted.source_id,
        source_name: current.source_name,
      });
    } else if (current.source_revision_id == null) {
      staleReasons.push({
        kind: "source_revision_unavailable",
        source_id: accepted.source_id,
        source_name: current.source_name,
        accepted_revision_id: accepted.source_revision_id,
      });
    } else if (current.source_revision_id !== accepted.source_revision_id) {
      staleReasons.push({
        kind: "source_revision_changed",
        source_id: accepted.source_id,
        source_name: current.source_name,
        accepted_revision_id: accepted.source_revision_id,
        current_revision_id: current.source_revision_id,
      });
    }

    if (current.effective_naming_digest !== accepted.effective_naming_digest) {
      staleReasons.push({
        kind: "naming_rules_changed",
        source_id: accepted.source_id,
        source_name: current.source_name,
        accepted_digest: accepted.effective_naming_digest,
        current_digest: current.effective_naming_digest,
      });
    }
  }

  const stale = nonEmpty(staleReasons);
  if (stale) {
    return {
      status: "stale",
      accepted_input_set_id: input.accepted.id,
      accepted_at: input.accepted.accepted_at,
      reasons: stale,
      untracked_sources: untrackedReasons,
    };
  }
  const untracked = nonEmpty(untrackedReasons);
  if (untracked) {
    return {
      status: "untracked",
      accepted_input_set_id: input.accepted.id,
      accepted_at: input.accepted.accepted_at,
      reasons: untracked,
    };
  }
  return {
    status: "current",
    accepted_input_set_id: input.accepted.id,
    accepted_at: input.accepted.accepted_at,
  };
}
