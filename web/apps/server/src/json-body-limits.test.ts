import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";
import {
  MAX_ASSISTANT_ACTION_BODY_BYTES,
  MAX_BULK_JSON_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
} from "./services/upload-limits.js";

const MiB = 1024 * 1024;

function jsonOfSize(bytes: number, fields: Record<string, unknown>): string {
  const skeleton = JSON.stringify({ ...fields, padding: "" });
  return JSON.stringify({ ...fields, padding: "x".repeat(bytes - skeleton.length) });
}

describe("JSON body limits", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-json-body-limits-"));
  const previousDataDir = process.env.PRINT_PARTNER_DATA_DIR;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ports: ReturnType<typeof createSelfHostPorts>;

  beforeAll(async () => {
    process.env.PRINT_PARTNER_DATA_DIR = dataDir;
    delete process.env.PRINT_PARTNER_API_KEY;
    ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    app = await buildApp(loadConfig(), ports);
  });

  afterAll(async () => {
    await app.close();
    ports.db.close();
    if (previousDataDir == null) delete process.env.PRINT_PARTNER_DATA_DIR;
    else process.env.PRINT_PARTNER_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("limits ordinary API JSON to 1 MiB", async () => {
    expect(MAX_JSON_BODY_BYTES).toBe(MiB);
    const atLimit = await app.inject({
      method: "POST",
      url: "/sources",
      headers: { "content-type": "application/json" },
      payload: jsonOfSize(MAX_JSON_BODY_BYTES, { name: "At limit", source_kind: "local" }),
    });
    const overLimit = await app.inject({
      method: "POST",
      url: "/sources",
      headers: { "content-type": "application/json" },
      payload: jsonOfSize(MAX_JSON_BODY_BYTES + 1, { name: "Over limit", source_kind: "local" }),
    });

    expect(atLimit.statusCode).not.toBe(413);
    expect(overLimit.statusCode).toBe(413);
  });

  it.each([
    ["POST", "/plans/999999/save"],
    ["PATCH", "/plans/999999/drafts/1/parts"],
    ["PUT", "/plans/999999/drafts/1/reconciliation"],
    ["POST", "/plans/999999/progress/import"],
    ["POST", "/api/v2/plans/999999/progress/import"],
    ["POST", "/plans/999999/plates/initialize"],
    ["PATCH", "/plans/999999/production-setup"],
    ["PUT", "/plans/999999/kit-manifest"],
    ["PUT", "/sources/999999/repo-manifest"],
  ] as const)("lets %s %s carry up to 8 MiB of bulk JSON", async (method, url) => {
    expect(MAX_BULK_JSON_BODY_BYTES).toBe(8 * MiB);
    const atLimit = await app.inject({
      method,
      url,
      headers: { "content-type": "application/json" },
      payload: jsonOfSize(MAX_BULK_JSON_BODY_BYTES, {}),
    });
    const overLimit = await app.inject({
      method,
      url,
      headers: { "content-type": "application/json" },
      payload: jsonOfSize(MAX_BULK_JSON_BODY_BYTES + 1, {}),
    });

    expect(atLimit.statusCode).not.toBe(413);
    expect(overLimit.statusCode).toBe(413);
  });

  it("limits assistant action bodies to 96 MiB", async () => {
    expect(MAX_ASSISTANT_ACTION_BODY_BYTES).toBe(96 * MiB);
    const atLimit = await app.inject({
      method: "POST",
      url: "/assistant/actions/apply",
      headers: { "content-type": "application/json" },
      payload: jsonOfSize(MAX_ASSISTANT_ACTION_BODY_BYTES, {}),
    });
    const overLimit = await app.inject({
      method: "POST",
      url: "/assistant/actions/dismiss",
      headers: { "content-type": "application/json" },
      payload: jsonOfSize(MAX_ASSISTANT_ACTION_BODY_BYTES + 1, {}),
    });

    expect(atLimit.statusCode).toBe(400);
    expect(atLimit.json()).toEqual(expect.objectContaining({ detail: "action is required" }));
    expect(overLimit.statusCode).toBe(413);
  });
});
