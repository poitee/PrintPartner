import { useCallback, useRef, useState } from "react";
import type { PlanEditablePart } from "../context/PlanWorkspaceContext";
import type { PlanRowIdentity } from "../lib/planDraftPartMatch";

export type PlanFileChoice = Readonly<{ part: PlanEditablePart; included: boolean }>;
export type PlanFileChoiceBatch = Readonly<{
  choices: readonly PlanFileChoice[];
  acknowledgeSaved: () => void;
}>;
type Choices = ReadonlyMap<string, PlanFileChoice>;
type ChoiceSave = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; error: unknown };
type BuildChoices = Readonly<{ choices: Choices; save: ChoiceSave }>;
const EMPTY: BuildChoices = { choices: new Map(), save: { kind: "idle" } };

export function planFileIdentity(part: PlanRowIdentity): string {
  return JSON.stringify([part.source_layer, part.relative_path, part.match_key]);
}

export function usePlanFileChoices(
  profileId: number | null,
  save: (profileId: number, batch: PlanFileChoiceBatch) => Promise<void>,
) {
  const [byBuild, setByBuild] = useState<ReadonlyMap<number, BuildChoices>>(new Map());
  const current = useRef(byBuild);
  const jobs = useRef(new Map<number, Promise<void>>());
  const update = useCallback((id: number, edit: (state: BuildChoices) => BuildChoices) => {
    const next = new Map(current.current);
    next.set(id, edit(next.get(id) ?? EMPTY));
    current.current = next;
    setByBuild(next);
  }, []);

  const flush = useCallback((id: number, retryFailed = false): Promise<void> => {
    const running = jobs.current.get(id);
    if (running) return running;
    const currentState = current.current.get(id) ?? EMPTY;
    if (currentState.save.kind === "failed" && !retryFailed) {
      return Promise.reject(currentState.save.error);
    }
    update(id, (state) => ({ ...state, save: { kind: "saving" } }));
    const job = Promise.resolve().then(async () => {
      while (true) {
        const batch = current.current.get(id)?.choices ?? EMPTY.choices;
        if (batch.size === 0) return;
        const acknowledgeSaved = () => update(id, (state) => {
          const choices = new Map(state.choices);
          for (const [key, choice] of batch) {
            if (choices.get(key)?.included === choice.included) choices.delete(key);
          }
          return {
            choices,
            save: state.save.kind === "failed" ? { kind: "idle" } : state.save,
          };
        });
        await save(id, { choices: [...batch.values()], acknowledgeSaved });
        acknowledgeSaved();
      }
    }).catch((error: unknown) => {
      update(id, (state) => ({ ...state, save: { kind: "failed", error } }));
      throw error;
    }).finally(() => {
      jobs.current.delete(id);
      update(id, (state) => state.save.kind === "saving" ? { ...state, save: { kind: "idle" } } : state);
    });
    jobs.current.set(id, job);
    return job;
  }, [save, update]);

  const select = useCallback((parts: readonly PlanEditablePart[], included: boolean) => {
    if (profileId == null) return Promise.reject(new Error("Choose a Build first"));
    if (parts.length === 0) return Promise.resolve();
    update(profileId, (state) => {
      const choices = new Map(state.choices);
      for (const part of parts) choices.set(planFileIdentity(part), { part, included });
      return { ...state, choices };
    });
    return flush(profileId, true);
  }, [flush, profileId, update]);

  const hasPending = useCallback((id: number) => (current.current.get(id)?.choices.size ?? 0) > 0, []);
  const discard = useCallback((id: number) => update(id, () => EMPTY), [update]);
  const state = profileId == null ? EMPTY : byBuild.get(profileId) ?? EMPTY;
  return {
    choices: state.choices,
    saving: state.save.kind === "saving",
    error: state.save.kind === "failed" ? state.save.error : null,
    select, flush, hasPending, discard,
  };
}
