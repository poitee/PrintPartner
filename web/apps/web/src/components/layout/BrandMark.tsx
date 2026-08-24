import { cn } from "@/lib/utils";

/** Layered-sheet brand mark (two offset 10×12 rounded rects — not printer / not PP). */
export default function LayeredSheetMark({ className }: { className?: string }) {
  return (
    <svg
      className={cn("text-primary", className)}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="5" width="10" height="12" rx="2" fill="currentColor" opacity="0.45" />
      <rect x="7" y="2" width="10" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}
