import type { FastifyInstance } from "fastify";
import type { ProfileSyncResult } from "../services/profile-sync.js";

/**
 * Minimal in-process pub/sub that broadcasts profile-sync events to any client
 * connected to /ws/profile-sync. Mirrors the per-job WebSocket in jobs.ts, but
 * broadcasts a single stream to all listeners (profile changes are rare and small).
 */

const listeners = new Set<(event: ProfileSyncResult) => void>();

export function broadcastProfileSync(event: ProfileSyncResult): void {
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      /* drop listener errors */
    }
  }
}

export function subscribeProfileSync(listener: (event: ProfileSyncResult) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerProfileSyncWebSocket(app: FastifyInstance): void {
  app.get("/ws/profile-sync", { websocket: true }, (socket) => {
    const unsub = subscribeProfileSync((event) => {
      try {
        socket.send(JSON.stringify(event));
      } catch {
        /* socket already closed */
      }
    });
    socket.on("close", () => unsub());
  });
}
