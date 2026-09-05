import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { TRANSFER_ARTIFACT_TTL_MS } from "../services/transfer-artifact-retention.js";

function multipartHandoff(profileId: number, bytes: Buffer) {
  const boundary = "----pp-bambu-retention";
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

describe("Bambu Connect handoff retention", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("deletes a handoff after its download response finishes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-bambu-retention-"));
    roots.push(dataDir);
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const app = await buildApp({ ...loadConfig(), dataDir }, ports);

    try {
      const plan = await app.inject({
        method: "POST",
        url: "/plans",
        payload: { name: "Retention test" },
      });
      const profileId = Number(plan.json().id);
      expect(profileId).toBeGreaterThan(0);
      const bytes = Buffer.from("G1 X1 Y1\n");
      const handoff = await app.inject({
        method: "POST",
        url: "/bambu-connect/handoff",
        ...multipartHandoff(profileId, bytes),
      });
      expect(handoff.statusCode).toBe(200);
      const body = handoff.json() as { handoff_id: string; download_path: string };
      const directory = join(
        dataDir,
        "exports",
        "tenant-default",
        "bambu-connect",
        body.handoff_id,
      );
      expect(existsSync(directory)).toBe(true);

      const download = await app.inject({ method: "GET", url: body.download_path });

      expect(download.statusCode).toBe(200);
      expect(download.rawPayload).toEqual(bytes);
      expect(existsSync(directory)).toBe(false);
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("expires an abandoned handoff before serving it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-bambu-retention-"));
    roots.push(dataDir);
    const id = "00000000-0000-4000-8000-000000000001";
    const directory = join(
      dataDir,
      "exports",
      "tenant-default",
      "bambu-connect",
      id,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "plate.gcode"), "G1 X1");
    const old = new Date(Date.now() - TRANSFER_ARTIFACT_TTL_MS - 1_000);
    utimesSync(directory, old, old);
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const app = await buildApp({ ...loadConfig(), dataDir }, ports);

    try {
      const response = await app.inject({
        method: "GET",
        url: `/bambu-connect/handoff/${id}/file`,
      });

      expect(response.statusCode).toBe(404);
      expect(existsSync(directory)).toBe(false);
    } finally {
      await app.close();
      ports.db.close();
    }
  });
});
