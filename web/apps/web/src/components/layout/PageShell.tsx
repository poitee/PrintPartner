import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Props = {
  /**
   * reading — prose-weight pages (Help, NotFound): max-w-3xl
   * list — index/dashboard pages (Builds, All Production, Printers, Settings): max-w-6xl
   * work — full-bleed work surfaces (Library, Sources, Plan, Production, Checkoff)
   */
  width?: "reading" | "list" | "work";
  className?: string;
  children: ReactNode;
};

const WIDTHS = {
  reading: "max-w-3xl",
  list: "max-w-6xl",
  work: "max-w-none",
} as const;

/**
 * Standard page frame. AppLayout's <main> owns the outer padding; the shell owns
 * page rhythm through `.stack-page`, so pages do not hand-pick `space-y-*`.
 * Inside a page, use `.stack-section` between blocks and `.stack-row` inside a
 * block. See `docs/design-system.md`.
 */
export default function PageShell({ width = "work", className, children }: Props) {
  return (
    <div className={cn("stack-page mx-auto w-full", WIDTHS[width], className)}>
      {children}
    </div>
  );
}
