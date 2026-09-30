import { useEffect, useSyncExternalStore } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useUpdateProfileMutation } from "../queries/profiles";
import { cn } from "@/lib/utils";

type Props = {
  profileId: number;
  value: string | null | undefined;
  className?: string;
};

type RequestDraft =
  | { kind: "dirty" | "saving" | "saved"; text: string }
  | { kind: "failed"; text: string; error: string };

const drafts = new Map<number, RequestDraft>();
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
  const pending = useSyncExternalStore(subscribe, () => drafts.get(profileId) ?? null, () => null);
  const draft = pending?.text ?? value ?? "";

  useEffect(() => {
    if (pending?.kind === "saved" && pending.text === (value ?? "").trim()) {
      setRequestDraft(profileId, null);
    }
  }, [pending, profileId, value]);

  const persist = async () => {
    if (pending?.kind === "saving") return;
    const next = draft.trim();
    const prev = (value ?? "").trim();
    if (next === prev) {
      setRequestDraft(profileId, null);
      return;
    }
    setRequestDraft(profileId, { kind: "saving", text: draft });
    try {
      await updateMutation.mutateAsync({ id: profileId, special_request: next || null });
      setRequestDraft(profileId, { kind: "saved", text: next });
    } catch (error) {
      setRequestDraft(profileId, {
        kind: "failed", text: draft,
        error: error instanceof Error ? error.message : "Could not save the special request",
      });
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      <Input
        id={`plan-special-request-${profileId}`}
        value={draft}
        onChange={(e) => setRequestDraft(profileId, { kind: "dirty", text: e.target.value })}
        onBlur={() => { void persist(); }}
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
