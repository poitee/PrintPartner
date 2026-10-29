// Replays routes.json and upload-scenarios.json through the Node Moonraker adapter and
// writes node-oracle.json and node-oracle-upload.json, the expected output for
// rust/crates/pp-drivers/tests/ticket_t_21_moonraker_driver.rs and ticket_t_21_moonraker_upload.rs.
// From the repo root: (cd web/apps/server && npx tsx ../../../rust/crates/pp-drivers/tests/fixtures/moonraker/capture-node-oracle.mts)
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { moonrakerAdapter } from "../../../../../../web/apps/server/src/integrations/adapters/moonraker.js";
import { StatusExecution } from "../../../../../../web/apps/server/src/integrations/status-execution.js";

const here = new URL("./", import.meta.url);
const { routes, browse } = JSON.parse(readFileSync(new URL("routes.json", here), "utf8")) as {
  routes: Record<string, string>;
  browse: string[];
};
// "recorded" serves the fixtures; the others answer every request with one status.
const scenarios: Record<string, number | null> = { recorded: null, "http-500": 500, "http-404": 404 };
const execution = new StatusExecution();

async function settle<T>(work: Promise<T>) {
  try {
    return { ok: await work };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const out: Record<string, unknown> = {};
for (const [name, forced] of Object.entries(scenarios)) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const fixture = routes[req.url ?? ""];
    if (forced !== null || !fixture) {
      res.writeHead(forced ?? 404, { "content-type": "application/json" }).end("{}");
      return;
    }
    const { port } = server.address() as AddressInfo;
    const body = readFileSync(new URL(fixture, here), "utf8")
      .replaceAll("{ORIGIN}", `http://localhost:${port}`);
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const config = { base_url: `http://localhost:${port}/` };
  const result: Record<string, unknown> = {
    test_connection: await execution.test(moonrakerAdapter, config),
    status: await execution.probe(moonrakerAdapter, config),
    filament_used: await moonrakerAdapter.getFilamentUsed!(config),
    object_list: await moonrakerAdapter.getObjectList!(config),
    cameras: await settle(moonrakerAdapter.cameras!.list(config)),
    browse: {} as Record<string, unknown>,
  };
  for (const path of browse) {
    (result.browse as Record<string, unknown>)[path] = await settle(moonrakerAdapter.files!.browse(config, path));
  }
  server.close();
  out[name] = { ...JSON.parse(JSON.stringify(result)), requests };
}
writeFileSync(new URL("node-oracle.json", here), `${JSON.stringify(out, null, 2)}\n`);

type UploadScenario = {
  name: string;
  filename: string;
  start: boolean;
  replies: Record<string, [number, string]>;
};
const uploads = JSON.parse(readFileSync(new URL("upload-scenarios.json", here), "utf8")) as {
  file: string;
  scenarios: UploadScenario[];
};
const uploadOut: Record<string, unknown> = {};
for (const scenario of uploads.scenarios) {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      // Boundaries are random on both sides; compare everything else byte for byte.
      const contentType = req.headers["content-type"] ?? null;
      const boundary = contentType?.match(/boundary=(.+)$/)?.[1];
      let body = Buffer.concat(chunks).toString("utf8");
      if (boundary) body = body.replaceAll(boundary, "<BOUNDARY>");
      requests.push({
        line: `${req.method} ${req.url}`,
        content_type: boundary ? contentType!.replace(boundary, "<BOUNDARY>") : contentType,
        body,
      });
      const [status, reply] = scenario.replies[new URL(req.url ?? "/", "http://x").pathname] ?? [404, "{}"];
      res.writeHead(status, status >= 300 && status < 400 ? { location: "/elsewhere" } : {}).end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const result = await moonrakerAdapter.uploadFile!(
    { base_url: `http://localhost:${port}` },
    new TextEncoder().encode(uploads.file),
    scenario.filename,
    { start: scenario.start },
  );
  server.close();
  uploadOut[scenario.name] = { result, requests };
}
writeFileSync(new URL("node-oracle-upload.json", here), `${JSON.stringify(uploadOut, null, 2)}\n`);
