import type { PrinterCheckoffUnit, PrinterStorageEntry } from "@print-partner/contracts";

/**
 * The Required-unit coordinate the assignment API takes.
 *
 * A unit is identified by its part and its index within that part, so the token
 * is the pair. The selection set, the checkbox keys, and the request body all
 * have to agree on the spelling, which is why it lives here once.
 */
export function requiredUnitToken(
  unit: Pick<PrinterCheckoffUnit, "part_id" | "unit_index">,
): string {
  return `${unit.part_id}:${unit.unit_index}`;
}

export type AssignFieldName = "build" | "units";

/** One problem, named by the field it belongs to, for the summary and the field. */
export type AssignFieldError = Readonly<{ field: AssignFieldName; message: string }>;

/**
 * Everything wrong with the assign form right now.
 *
 * Returns every problem rather than the first, because the form asks for
 * several unrelated decisions and an operator should see all of them at once.
 */
export function validatePrintFileAssignment(input: {
  buildId: number | null;
  confirmedUnitCount: number;
  completed: boolean;
}): AssignFieldError[] {
  const errors: AssignFieldError[] = [];
  if (input.buildId == null) {
    errors.push({ field: "build", message: "Choose the Build this print belongs to" });
  }
  if (input.completed && input.confirmedUnitCount === 0) {
    errors.push({
      field: "units",
      message:
        "Confirm at least one Required unit, or clear \u201cThis print is already finished\u201d. A finished print with no units has nothing to check off.",
    });
  }
  return errors;
}

/** The Build id chosen in the form, or null when the select is still empty. */
export function chosenBuildId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export type StorageCrumb = Readonly<{ label: string; path: string }>;

/**
 * The trail from the storage root down to `path`.
 *
 * Always starts at the root, so an operator who followed a folder four deep has
 * one click back out rather than four.
 */
export function storageCrumbs(path: string): StorageCrumb[] {
  const crumbs: StorageCrumb[] = [{ label: "Printer storage", path: "" }];
  let walked = "";
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    walked = walked === "" ? segment : `${walked}/${segment}`;
    crumbs.push({ label: segment, path: walked });
  }
  return crumbs;
}

/**
 * Folders first, then files newest first.
 *
 * An operator browsing a print host is either descending into a folder or
 * reaching for what they just sliced, so both are at the top.
 */
export function sortStorageEntries(entries: readonly PrinterStorageEntry[]): PrinterStorageEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    if (left.kind === "directory") return left.name.localeCompare(right.name);
    return (right.modified_at ?? "").localeCompare(left.modified_at ?? "");
  });
}
