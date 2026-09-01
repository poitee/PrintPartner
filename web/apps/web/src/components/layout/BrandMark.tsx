import { cn } from "@/lib/utils";

/**
 * PrintPartner's mark: a build plate, quartered, with one unit placed on it.
 *
 * Inline SVG rather than a raster, so the ink follows `currentColor` and the
 * placed unit follows `--primary` in both themes. `public/icons/icon.svg` is
 * the same artwork with literal hex for the PWA, where CSS variables cannot
 * reach; keep the two in step.
 */
export default function LayeredSheetMark({ className }: { className?: string }) {
  return (
    <svg
      className={cn("h-7 w-7", className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 4.4H6.5A2.1 2.1 0 0 0 4.4 6.5V12H12Z" fill="var(--primary)" />
      <rect
        x="3.1"
        y="3.1"
        width="17.8"
        height="17.8"
        rx="3.4"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M12 4V20M4 12H20"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
