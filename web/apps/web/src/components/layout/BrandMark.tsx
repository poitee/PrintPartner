import { cn } from "@/lib/utils";

/** PrintPartner's interlocking filament-and-build-plate mark. */
export default function LayeredSheetMark({ className }: { className?: string }) {
  return (
    <img
      className={cn("h-7 w-7 object-contain", className)}
      src="/print-partner-mark.png"
      alt=""
      aria-hidden="true"
    />
  );
}
