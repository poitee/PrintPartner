/**
 * Concurrent HTTP MCP session capacity: reservations count toward max.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MCP_HTTP_SESSION_MAX,
  createMcpSessionCapacity,
} from "./http-routes.js";

describe("HTTP MCP session capacity reservations", () => {
  it("concurrent inits cannot exceed MCP_HTTP_SESSION_MAX", async () => {
    const sessions = new Map<string, { id: string }>();
    const capacity = createMcpSessionCapacity(sessions, MCP_HTTP_SESSION_MAX);

    const peaks: number[] = [];
    const attempt = async (): Promise<"ok" | "rejected"> => {
      const release = capacity.tryReserve();
      peaks.push(capacity.occupied());
      if (!release) return "rejected";

      // Simulate async StreamableHTTP init before onsessioninitialized.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));

      const id = randomUUID();
      sessions.set(id, { id });
      release();
      peaks.push(capacity.occupied());
      return "ok";
    };

    // Far more concurrent attempts than the hard max.
    const results = await Promise.all(
      Array.from({ length: MCP_HTTP_SESSION_MAX * 3 }, () => attempt()),
    );

    const accepted = results.filter((r) => r === "ok").length;
    const rejected = results.filter((r) => r === "rejected").length;

    expect(accepted).toBe(MCP_HTTP_SESSION_MAX);
    expect(rejected).toBe(MCP_HTTP_SESSION_MAX * 2);
    expect(sessions.size).toBe(MCP_HTTP_SESSION_MAX);
    expect(capacity.pendingReservations()).toBe(0);
    expect(capacity.occupied()).toBe(MCP_HTTP_SESSION_MAX);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(MCP_HTTP_SESSION_MAX);
  });

  it("releases reservation when async init fails before registration", async () => {
    const sessions = new Map<string, { id: string }>();
    const capacity = createMcpSessionCapacity(sessions, 2);

    const release = capacity.tryReserve();
    expect(release).not.toBeNull();
    expect(capacity.occupied()).toBe(1);

    await new Promise<void>((r) => setImmediate(r));
    release!();
    expect(capacity.pendingReservations()).toBe(0);
    expect(capacity.occupied()).toBe(0);

    const again = capacity.tryReserve();
    expect(again).not.toBeNull();
    again!();
  });

  it("counts pending reservations in the max check with live sessions", () => {
    const sessions = new Map<string, { id: string }>([
      ["a", { id: "a" }],
      ["b", { id: "b" }],
    ]);
    const capacity = createMcpSessionCapacity(sessions, 3);
    const r1 = capacity.tryReserve();
    expect(r1).not.toBeNull();
    expect(capacity.occupied()).toBe(3);
    expect(capacity.tryReserve()).toBeNull();
    // Convert reservation → session
    sessions.set("c", { id: "c" });
    r1!();
    expect(capacity.occupied()).toBe(3);
    expect(capacity.tryReserve()).toBeNull();
  });
});
