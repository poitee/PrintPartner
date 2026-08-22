import type { ReviewPart } from "../api/engine";

type Props = {
  part: Pick<ReviewPart, "spool_badge">;
  className?: string;
};

export default function SpoolRemainingBadge({ part, className }: Props) {
  if (!part.spool_badge) return null;
  return (
    <span
      className={`text-xs text-muted-foreground ${className ?? ""}`}
      title={part.spool_badge}
    >
      {part.spool_badge}
    </span>
  );
}
