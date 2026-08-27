export type PlanRevisionIdentityRow = {
  readonly provenanceKind: string;
  readonly inputSetId: number | null;
};

export type AcceptedPlanRevisionIdentity<Row extends PlanRevisionIdentityRow> = Omit<
  Row,
  "provenanceKind" | "inputSetId"
> & ({ provenanceKind: "tracked"; inputSetId: number } | { provenanceKind: "legacy"; inputSetId: null });

export function acceptedPlanRevisionIdentity<Row extends PlanRevisionIdentityRow>(
  row: Row,
): AcceptedPlanRevisionIdentity<Row> {
  if (row.provenanceKind === "tracked" && row.inputSetId != null) {
    return { ...row, provenanceKind: "tracked", inputSetId: row.inputSetId } as AcceptedPlanRevisionIdentity<Row>;
  }
  if (row.provenanceKind === "legacy" && row.inputSetId == null) {
    return { ...row, provenanceKind: "legacy", inputSetId: null } as AcceptedPlanRevisionIdentity<Row>;
  }
  throw new Error("Accepted Plan revision provenance is invalid");
}
