import { randomBytes } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSelfHostPorts } from "./adapters/self-host/index.js";

const PAYLOAD_BYTES = 96 * 1024 * 1024;

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

type MemoryPeak = Readonly<{ heapAndExternal: number; rss: number }>;

function heapAndExternal(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
}

async function measurePeak<T>(work: () => Promise<T>): Promise<{ result: T; peak: MemoryPeak }> {
  collectGarbage();
  await new Promise((resolve) => setTimeout(resolve, 100));
  collectGarbage();
  const baseline = { heapAndExternal: heapAndExternal(), rss: process.memoryUsage().rss };
  let peakHeap = baseline.heapAndExternal;
  let peakRss = baseline.rss;
  const sample = () => {
    peakHeap = Math.max(peakHeap, heapAndExternal());
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  };
  const timer = setInterval(sample, 1);
  try {
    const result = await work();
    sample();
    return {
      result,
      peak: {
        heapAndExternal: peakHeap - baseline.heapAndExternal,
        rss: peakRss - baseline.rss,
      },
    };
  } finally {
    clearInterval(timer);
  }
}

function postMultipartFile(
  url: string,
  file: Readonly<{ field: string; filename: string; path: string }>,
): Promise<{ status: number; body: string }> {
  const boundary = "----pp-upload-memory-boundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const length = head.length + statSync(file.path).size + tail.length;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(length),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.write(head);
    const stream = createReadStream(file.path);
    stream.on("error", reject);
    stream.on("end", () => outgoing.end(tail));
    stream.pipe(outgoing, { end: false });
  });
}

describe("upload memory", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pp-upload-memory-"));
  const payloadDir = mkdtempSync(join(tmpdir(), "pp-upload-memory-payload-"));
  const zipPath = join(payloadDir, "source.zip");
  const previousDataDir = process.env.PRINT_PARTNER_DATA_DIR;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ports: ReturnType<typeof createSelfHostPorts>;
  let baseUrl: string;

  beforeAll(async () => {
    writeFileSync(zipPath, zipSync({ "parts/payload.bin": [randomBytes(PAYLOAD_BYTES), { level: 0 }] }));
    process.env.PRINT_PARTNER_DATA_DIR = dataDir;
    delete process.env.PRINT_PARTNER_API_KEY;
    ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    app = await buildApp(loadConfig(), ports);
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    ports.db.close();
    if (previousDataDir == null) delete process.env.PRINT_PARTNER_DATA_DIR;
    else process.env.PRINT_PARTNER_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(payloadDir, { recursive: true, force: true });
  });

  it("streams a large Source archive to disk instead of holding it in memory", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sources",
      payload: { name: "Memory Source", source_kind: "local" },
    });
    const sourceId = (created.json() as { id: number }).id;

    const { result, peak } = await measurePeak(() =>
      postMultipartFile(`${baseUrl}/sources/${sourceId}/upload-zip`, {
        field: "file",
        filename: "source.zip",
        path: zipPath,
      }),
    );

    const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    process.stderr.write(
      `upload-zip ${mib(statSync(zipPath).size)} MiB: peak heap+external +${mib(peak.heapAndExternal)} MiB, peak RSS +${mib(peak.rss)} MiB\n`,
    );
    expect(result.status, result.body).toBe(200);
    expect(peak.heapAndExternal).toBeLessThan(PAYLOAD_BYTES);
  }, 120_000);
});
