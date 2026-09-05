import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "../db/repository.js";
import type { InProcessJobRunner } from "./jobs.js";

const resolveBambuConnectHostPath = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("path mapping failed");
  }),
);

vi.mock("../services/bambu-connect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/bambu-connect.js")>()),
  resolveBambuConnectHostPath,
}));

import { registerBambuConnectRoutes } from "./bambu-connect.js";

function multipartHandoff(profileId: number, bytes: Buffer) {
  const boundary = "----pp-bambu-failure-cleanup";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="profile_id"\r\n\r\n${profileId}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="launch"\r\n\r\nfalse\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plate.gcode"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

describe("Bambu Connect handoff failure cleanup", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("removes the staged file when post-upload processing fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-bambu-failure-cleanup-"));
    roots.push(dataDir);
    const exportsDir = join(dataDir, "exports");
    const app = Fastify();
    await app.register(multipart);
    await registerBambuConnectRoutes(app, {
      repo: {
        getOwnedProfileIdentity: () => ({ id: 1 }),
      } as unknown as AppRepository,
      jobs: {
        getExportsDir: () => exportsDir,
      } as unknown as InProcessJobRunner,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/bambu-connect/handoff",
        ...multipartHandoff(1, Buffer.from("G1 X1 Y1\n")),
      });

      expect(response.statusCode).toBe(500);
      expect(resolveBambuConnectHostPath).toHaveBeenCalledOnce();
      const handoffRoot = join(exportsDir, "bambu-connect");
      expect(existsSync(handoffRoot) ? readdirSync(handoffRoot) : []).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
