import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useUpdateProfileMutation } from "../queries/profiles";
import { cn } from "@/lib/utils";
import { useBuildSaveFlushRegistry } from "../context/BuildSaveFlushContext";
import {
  clearFailedAuxiliarySave,
  retainFailedAuxiliarySave,
} from "../lib/planAuxiliarySaveIntent";

type Props = {
  profileId: number;
  value: string | null | undefined;
  className?: string;
};

type RequestDraft =
  | { kind: "dirty" | "saving" | "saved"; text: string }
  | { kind: "failed"; text: string; error: string };

type SpecialRequestBody = Readonly<{ id: number; special_request: string | null }>;

const drafts = new Map<number, RequestDraft>();
const failedBodies = new Map<number, SpecialRequestBody>();
const inFlightByProfile = new Map<number, Promise<void>>();
const listeners = new Set<() => void>();

function warnOnUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = "";
}

function setRequestDraft(profileId: number, draft: RequestDraft | null) {
  if (draft) drafts.set(profileId, draft);
  else drafts.delete(profileId);
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeunload", warnOnUnload);
    if ([...drafts.values()].some((item) => item.kind !== "saved")) {
      window.addEventListener("beforeunload", warnOnUnload);
    }
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function persistBody(
  profileId: number,
  body: SpecialRequestBody,
  mutateAsync: (body: SpecialRequestBody) => Promise<unknown>,
): Promise<void> {
  const active = inFlightByProfile.get(profileId);
  if (active) {
    await active;
    return;
  }
  const run = (async () => {
    setRequestDraft(profileId, { kind: "saving", text: body.special_request ?? "" });
    try {
      await mutateAsync(body);
      setRequestDraft(profileId, { kind: "saved", text: (body.special_request ?? "").trim() });
      failedBodies.delete(profileId);
      clearFailedAuxiliarySave(profileId, "special_request");
    } catch (error) {
      failedBodies.set(profileId, body);
      retainFailedAuxiliarySave(profileId, "special_request", async () => {
        await persistBody(profileId, body, mutateAsync);
      });
      setRequestDraft(profileId, {
        kind: "failed",
        text: body.special_request ?? "",
        error: error instanceof Error ? error.message : "Could not save the special request",
      });
      throw error;
    } finally {
      if (inFlightByProfile.get(profileId) === run) inFlightByProfile.delete(profileId);
    }
  })();
  inFlightByProfile.set(profileId, run);
  await run;
}

export function flushSpecialRequestSave(
  profileId: number,
  mutateAsync: (body: SpecialRequestBody) => Promise<unknown>,
  value: string | null | undefined,
): Promise<void> {
  const inFlight = inFlightByProfile.get(profileId);
  if (inFlight) return inFlight;
  const retained = failedBodies.get(profileId);
  if (retained) return persistBody(profileId, retained, mutateAsync);
  const draft = drafts.get(profileId);
  if (draft?.kind === "failed" || draft?.kind === "dirty") {
    const next = draft.text.trim();
    const prev = (value ?? "").trim();
    if (next === prev) {
      setRequestDraft(profileId, null);
      return Promise.resolve();
    }
    return persistBody(profileId, { id: profileId, special_request: next || null }, mutateAsync);
  }
  if (draft?.kind === "saving") {
    return inFlightByProfile.get(profileId) ?? Promise.resolve();
  }
  return Promise.resolve();
}

/**
 * Per-Build special-request note.
 *
 * It looks like every other text field. The earlier "quiet" treatment removed
 * the border and dimmed the placeholder, which left no visible boundary in
 * either theme and pushed the placeholder below AA contrast.
 */
export default function PlanSpecialRequestField({
  profileId,
  value,
  className,
}: Props) {
  const updateMutation = useUpdateProfileMutation();
  const registerFlush = useBuildSaveFlushRegistry();
  const pending = useSyncExternalStore(subscribe, () => drafts.get(profileId) ?? null, () => null);
  const draft = pending?.text ?? value ?? "";

  const mutateBody = useCallback(
    (body: SpecialRequestBody) => updateMutation.mutateAsync(body),
    [updateMutation],
  );

  useEffect(() => {
    if (pending?.kind === "saved" && pending.text === (value ?? "").trim()) {
      setRequestDraft(profileId, null);
    }
  }, [pending, profileId, value]);

  useEffect(() => {
    return registerFlush(profileId, () => flushSpecialRequestSave(profileId, mutateBody, value));
  }, [mutateBody, profileId, registerFlush, value]);

  const persist = async () => {
    const inFlight = inFlightByProfile.get(profileId);
    if (inFlight) {
      await inFlight;
      return;
    }
    if (pending?.kind === "saving") return;
    const retained = failedBodies.get(profileId);
    if (retained) {
      await persistBody(profileId, retained, mutateBody);
      return;
    }
    const next = draft.trim();
    const prev = (value ?? "").trim();
    if (next === prev) {
      setRequestDraft(profileId, null);
      return;
    }
    await persistBody(profileId, { id: profileId, special_request: next || null }, mutateBody);
  };

  return (
    <div className={cn("space-y-2", className)}>
      <Input
        id={`plan-special-request-${profileId}`}
        value={draft}
        onChange={(e) => {
          failedBodies.delete(profileId);
          clearFailedAuxiliarySave(profileId, "special_request");
          setRequestDraft(profileId, { kind: "dirty", text: e.target.value });
        }}
        onBlur={() => { void persist().catch(() => {}); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder="contact customer before printing"
        aria-label="Special request"
        aria-invalid={pending?.kind === "failed"}
        disabled={pending?.kind === "saving" || updateMutation.isPending}
        className="h-9 bg-muted/40 text-sm shadow-none"
      />
      {pending?.kind === "saving" && <p role="status" className="text-xs text-muted-foreground">Saving special request…</p>}
      {pending?.kind === "failed" && (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          <span>Special request was not saved: {pending.error}</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => { void persist(); }}>Retry save</Button>
        </div>
      )}
    </div>
  );
}

export function resetSpecialRequestSaveStateForTests(): void {
  drafts.clear();
  failedBodies.clear();
  inFlightByProfile.clear();
  listeners.clear();
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeunload", warnOnUnload);
  }
}
