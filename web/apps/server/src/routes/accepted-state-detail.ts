export type AcceptedStateUnavailableReason = "compatibility_dirty" | "uninitialized";

export function acceptedStateDetail(reason: AcceptedStateUnavailableReason): string {
  return reason === "compatibility_dirty"
    ? "Accepted Plan requires compatibility repair"
    : "Accepted Plan operational state is not initialized";
}
