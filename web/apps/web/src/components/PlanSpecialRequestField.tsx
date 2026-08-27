import { useEffect, useState } from "react";
import { Input } from "./ui/input";
import { useUpdateProfileMutation } from "../queries/profiles";
import { cn } from "@/lib/utils";

type Props = {
  profileId: number;
  value: string | null | undefined;
  className?: string;
};

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
        "h-9 bg-muted/40 text-sm shadow-none",
        className,
      )}
    />
  );
}
