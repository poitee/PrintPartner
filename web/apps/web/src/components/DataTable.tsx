import type { HTMLAttributes, TableHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type DataTableProps = TableHTMLAttributes<HTMLTableElement>;

export function DataTable({ className, ...props }: DataTableProps) {
  return <table className={cn("data-table", className)} {...props} />;
}

export function DataTableWrap({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("table-wrap overflow-x-auto", className)} {...props} />;
}
