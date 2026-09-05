import type { FastifyInstance } from "fastify";
import type { ProfileSyncResult } from "../services/profile-sync.js";

/**
 * Minimal in-process pub/sub that broadcasts profile-sync events to any client
 * connected to /ws/profile-sync. Mirrors the per-job WebSocket in jobs.ts, but
 * broadcasts a single stream to all listeners (profile changes are rare and small).
 */

const listenersByTenant = new Map<string, Set<(event: ProfileSyncResult) => void>>();

export function broadcastProfileSync(tenantId: string, event: ProfileSyncResult): void {
  for (const listener of listenersByTenant.get(tenantId) ?? []) {
    try {
      listener(event);
    } catch {
      /* drop listener errors */
    }
  }
}

export function subscribeProfileSync(
  tenantId: string,
  listener: (event: ProfileSyncResult) => void,
): () => void {
  const listeners = listenersByTenant.get(tenantId) ?? new Set();
  listeners.add(listener);
  listenersByTenant.set(tenantId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByTenant.delete(tenantId);
  };
}

export function registerProfileSyncWebSocket(app: FastifyInstance): void {
  app.get("/ws/profile-sync", { websocket: true }, (socket, request) => {
    const unsub = subscribeProfileSync(request.tenantId, (event) => {
      try {
        socket.send(JSON.stringify(event));
      } catch {
        /* socket already closed */
      }
    });
    socket.on("close", () => unsub());
  });
}
