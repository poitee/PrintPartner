// Replays fixtures/drivers/prusalink/driver/routes.json through the Node adapter
// and checks the results against node-oracle-reads.json, which the Rust driver
// test (rust/crates/pp-drivers/tests/ticket_t_22_prusalink_reads.rs) also replays.
// UPDATE_PRUSALINK_ORACLE=1 rewrites the oracle file instead of checking it.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { prusalinkAdapter } from "./prusalink.js";

const here = new URL("../../../../../../fixtures/drivers/prusalink/driver/", import.meta.url);
const challenge = JSON.parse(readFileSync(new URL("../digest-401.json", here), "utf8")) as {
  headers: Record<string, string>;
};

type Routes = {
  routes: Record<string, string>;
  browse: string[];
  configs: Record<string, Record<string, string>>;
};

async function settle<T>(work: Promise<T>) {
  try {
    return { ok: await work };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

describe("PrusaLink driver oracle", () => {
  it("reads match node-oracle-reads.json", async () => {
    const { routes, browse, configs } = JSON.parse(
      readFileSync(new URL("routes.json", here), "utf8"),
    ) as Routes;
    const scenarios: Record<string, [string, number | null]> = {
      recorded: ["auto", null],
      pinned: ["pinned", null],
      "no-password": ["auto", null],
      "http-500": ["auto", 500],
      "http-404": ["auto", 404],
    };
    const out: Record<string, unknown> = {};
    for (const [name, [configName, forced]] of Object.entries(scenarios)) {
      const requests: string[] = [];
      const server = createServer((req, res) => {
        const authorized = Boolean(req.headers.authorization);
        const range = req.headers.range ? ` range=${req.headers.range}` : "";
        requests.push(`${req.method} ${req.url}${authorized ? " +auth" : ""}${range}`);
        if (forced !== null) {
          res.writeHead(forced, { "content-type": "application/json" }).end("{}");
          return;
        }
        if (!authorized) {
          res.writeHead(401, challenge.headers).end();
          return;
        }
        const fixture = routes[req.url ?? ""];
        if (!fixture) {
          res.writeHead(404, { "content-type": "application/json" }).end("{}");
          return;
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(readFileSync(new URL(fixture, here)));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const config = {
        base_url: `http://127.0.0.1:${port}/`,
        username: "fixture-user",
        password: name === "no-password" ? "" : "synthetic-fixture-password",
        ...configs[configName],
      };
      try {
        const result: Record<string, unknown> = {
          cameras: await settle(prusalinkAdapter.cameras!.list(config)),
          object_list: await prusalinkAdapter.getObjectList!(config),
        };
        const listings: Record<string, unknown> = {};
        for (const path of browse) {
          listings[path] = await settle(prusalinkAdapter.files!.browse(config, path));
        }
        out[name] = JSON.parse(JSON.stringify({ ...result, browse: listings, requests }));
      } finally {
        server.close();
      }
    }
    const text = `${JSON.stringify(out, null, 2)}\n`;
    const oracle = new URL("node-oracle-reads.json", here);
    if (process.env.UPDATE_PRUSALINK_ORACLE) {
      writeFileSync(oracle, text);
      return;
    }
    expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(oracle, "utf8")));
  });
});
