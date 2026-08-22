import { useEffect, useState } from "react";
import { Input } from "./ui/input";
import { useUpdateProfileMutation } from "../queries/profiles";
import { cn } from "../lib/utils";

type Props = {
  profileId: number;
  value: string | null | undefined;
  className?: string;
};

/** Quiet per-plan special-request note (Plan edit surface). */
export default function PlanSpecialRequestField({
  profileId,
  value,
  className,
}: Props) {
  const updateMutation = useUpdateProfileMutation();
  const [draft, setDraft] = useState(value ?? "");

  useEffect(() => {
    setDraft(value ?? "");
  }, [profileId, value]);

  const persist = () => {
    const next = draft.trim();
    const prev = (value ?? "").trim();
    if (next === prev) return;
    void updateMutation.mutateAsync({
      id: profileId,
      special_request: next || null,
    });
  };

  return (
    <Input
      id={`plan-special-request-${profileId}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => persist()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
      placeholder="contact customer before printing"
      aria-label="Special request"
      disabled={updateMutation.isPending}
      className={cn(
        "h-8 border-transparent bg-muted/40 text-sm shadow-none placeholder:text-muted-foreground/70 hover:border-border/60 focus-visible:border-input",
        className,
      )}
    />
  );
}
