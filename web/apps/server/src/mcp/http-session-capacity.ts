/**
 * Sync slot reservation for HTTP MCP sessions.
 * Count live sessions + in-flight init reservations against max so concurrent
 * initializes cannot overshoot before onsessioninitialized runs.
 */

export type McpSessionCapacity = {
  /** sessions.size + held reservations */
  occupied: () => number;
  pendingReservations: () => number;
  /**
   * Reserve one slot immediately (sync). Returns a one-shot release, or null
   * when at capacity. Call release after the session is registered in `sessions`
   * (or on init failure / close without registration).
   */
  tryReserve: () => (() => void) | null;
};

export function createMcpSessionCapacity(
  sessions: { readonly size: number },
  max: number,
): McpSessionCapacity {
  let pending = 0;

  return {
    occupied: () => sessions.size + pending,
    pendingReservations: () => pending,
    tryReserve: () => {
      if (sessions.size + pending >= max) return null;
      pending += 1;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        pending = Math.max(0, pending - 1);
      };
    },
  };
}
