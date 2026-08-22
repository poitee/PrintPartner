import { cn } from "../../lib/utils";
import { categorySwatch } from "../../lib/librarySourceMeta";
import CategoryDropTarget from "../sources/CategoryDropTarget";

type Props = {
  categories: string[];
  onDropSourceCategory: (sourceId: number, category: string | null) => void;
  className?: string;
};

/** Quiet category chips for Plan attached-sources drag-to-categorize. */
export default function PlanCategoryDropStrip({
  categories,
  onDropSourceCategory,
  className,
}: Props) {
  if (categories.length === 0) return null;

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      aria-label="Drop sources onto a category"
    >
      <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Drop onto
      </span>
      {categories.map((name) => (
        <CategoryDropTarget
          key={name}
          category={name}
          onDropSource={onDropSourceCategory}
          className="rounded-md"
        >
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[11.5px] text-foreground">
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
              style={{ background: categorySwatch(name) }}
              aria-hidden
            />
            {name}
          </span>
        </CategoryDropTarget>
      ))}
      <CategoryDropTarget
        category={null}
        onDropSource={onDropSourceCategory}
        className="rounded-md"
      >
        <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-[11.5px] text-muted-foreground">
          Uncategorised
        </span>
      </CategoryDropTarget>
    </div>
  );
}
