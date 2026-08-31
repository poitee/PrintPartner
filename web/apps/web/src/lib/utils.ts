import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The named type scale lives in `@theme` (`--text-body`, `--text-meta`, …), which
 * tailwind-merge cannot discover. Without this it files `text-body` under
 * text-color, so `cn("text-body text-muted-foreground")` drops the size and the
 * element falls back to the browser default.
 */
const TYPE_SCALE = ["micro", "meta", "body", "lead", "title", "section", "page"] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TYPE_SCALE] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
