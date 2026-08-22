import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

type Props = {
  children: ReactNode;
  className?: string;
};

/** Touch-friendly action row: 2-column grid on phones, inline on sm+. */
export default function PageHeaderActions({ children, className }: Props) {
  return (
    <div
      className={cn(
        "grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:gap-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
