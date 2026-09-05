import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./services/upload-limits.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./services/upload-limits.js")>()),
  MAX_JSON_BODY_BYTES: 64,
  MAX_ASSISTANT_ACTION_BODY_BYTES: 256,
  MAX_SOURCE_UPLOAD_BYTES: 64,
  MAX_KIT_BUNDLE_UPLOAD_BYTES: 64,
  MAX_PRINT_FILE_UPLOAD_BYTES: 64,
  MAX_BACKUP_UPLOAD_BYTES: 64,
  MAX_MULTIPART_FIELD_BYTES: 64,
}));

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";

const FILE_BYTES_OVER_TEST_LIMIT = Buffer.alloc(65, 0x61);

function directoryEntries(path: string): string[] {
  return existsSync(path) ? readdirSync(path) : [];
}

function responseDetail(body: unknown): string {
  if (
    body &&
    typeof body === "object" &&
    "detail" in body &&
    typeof body.detail === "string"
  ) {
    return body.detail;
  }
  throw new Error("Upload response did not contain a detail string");
}

function multipartUpload(
  file: Readonly<{ field: string; filename: string; content: Buffer }>,
  fields: ReadonlyArray<Readonly<{ name: string; value: string }>> = [],
) {
  const boundary = "----pp-upload-boundary-test";
  const parts: Buffer[] = [];
  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
          `${field.value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("multipart upload boundaries", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-upload-boundaries-"));
  const previousDataDir = process.env.PRINT_PARTNER_DATA_DIR;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ports: ReturnType<typeof createSelfHostPorts>;
  let sourceId: number;

  beforeAll(async () => {
    process.env.PRINT_PARTNER_DATA_DIR = dataDir;
    delete process.env.PRINT_PARTNER_API_KEY;
    ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    app = await buildApp(loadConfig(), ports);
    const created = await app.inject({
      method: "POST",
      url: "/sources",
      payload: { name: "Upload boundary Source", source_kind: "local" },
    });
    const body: unknown = created.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("id" in body) ||
      typeof body.id !== "number"
    ) {
      throw new Error("Source fixture did not return an id");
    }
    sourceId = body.id;
  });

  afterAll(async () => {
    await app.close();
    ports.db.close();
    if (previousDataDir == null) delete process.env.PRINT_PARTNER_DATA_DIR;
    else process.env.PRINT_PARTNER_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects an ordinary JSON body above the global limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sources",
      payload: { name: "x".repeat(100), source_kind: "local" },
    });

    expect(response.statusCode).toBe(413);
  });

  it("lets a large assistant action body reach its route handler", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/assistant/actions/apply",
      payload: { padding: "x".repeat(100) },
    });

    expect(response.statusCode).toBe(400);
    expect(responseDetail(response.json())).toBe("action is required");
  });

  it("rejects an oversized Source archive before archive parsing", async () => {
    const upload = multipartUpload({
      field: "file",
      filename: "source.zip",
      content: FILE_BYTES_OVER_TEST_LIMIT,
    });

    const response = await app.inject({
      method: "POST",
      url: `/sources/${sourceId}/upload-zip`,
      ...upload,
    });

    expect(response.statusCode).toBe(413);
    expect(responseDetail(response.json())).toContain("256 MiB");
  });

  it("rejects an oversized kit bundle before bundle parsing", async () => {
    const upload = multipartUpload({
      field: "file",
      filename: "project.print-partner-kit.zip",
      content: FILE_BYTES_OVER_TEST_LIMIT,
    });

    const response = await app.inject({
      method: "POST",
      url: "/imports/kit-bundle",
      ...upload,
    });

    expect(response.statusCode).toBe(413);
    expect(responseDetail(response.json())).toContain("64 MiB");
  });

  it.each(["/jobs/printer-upload", "/printer-send-queue"])(
    "rejects an oversized printer upload at %s",
    async (url) => {
      const upload = multipartUpload(
        {
          field: "file",
          filename: "plate.gcode",
          content: FILE_BYTES_OVER_TEST_LIMIT,
        },
        [{ name: "printer_id", value: "printer-1" }],
      );

      const response = await app.inject({ method: "POST", url, ...upload });

      expect(response.statusCode).toBe(413);
      expect(responseDetail(response.json())).toContain("64 MiB");
      expect(
        directoryEntries(
          join(dataDir, "exports", "tenant-default", "printer-uploads"),
        ),
      ).toEqual([]);
    },
  );

  it("rejects an oversized Bambu Connect handoff", async () => {
    const upload = multipartUpload({
      field: "file",
      filename: "plate.gcode",
      content: FILE_BYTES_OVER_TEST_LIMIT,
    });

    const response = await app.inject({
      method: "POST",
      url: "/bambu-connect/handoff",
      ...upload,
    });

    expect(response.statusCode).toBe(413);
    expect(responseDetail(response.json())).toContain("64 MiB");
    expect(
      directoryEntries(
        join(dataDir, "exports", "tenant-default", "bambu-connect"),
      ),
    ).toEqual([]);
  });

  it.each(["/backups/validate", "/backups/restore"])(
    "rejects an oversized backup upload at %s",
    async (url) => {
      const upload = multipartUpload({
        field: "file",
        filename: "backup.tar.gz",
        content: FILE_BYTES_OVER_TEST_LIMIT,
      });

      const response = await app.inject({ method: "POST", url, ...upload });

      expect(response.statusCode).toBe(413);
      expect(responseDetail(response.json())).toContain("20 GiB");
      expect(
        directoryEntries(dataDir).filter(
          (name) => name.startsWith(".validate-upload-") || name.startsWith(".restore-upload-"),
        ),
      ).toEqual([]);
    },
  );
});
