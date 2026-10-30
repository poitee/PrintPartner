// Runs fixtures/drivers/prusalink/driver/digest-vectors.json through the Node
// Digest code and checks node-oracle-digest.json, which the Rust driver test
// (rust/crates/pp-drivers/tests/ticket_t_22_prusalink.rs) also replays.
// UPDATE_PRUSALINK_ORACLE=1 rewrites the oracle file instead of checking it.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildDigestAuthorization, parseWwwAuthenticate } from "./digest-auth.js";

const cnonce = vi.hoisted(() => ({ hex: "" }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: () => Buffer.from(cnonce.hex, "hex") };
});

const here = new URL("../../../../../fixtures/drivers/prusalink/driver/", import.meta.url);

type Vector = {
  name: string;
  header: string;
  username: string;
  password: string;
  method: string;
  uri: string;
  nc: number;
  cnonce: string;
};

describe("PrusaLink Digest oracle", () => {
  it("digest vectors match node-oracle-digest.json", () => {
    const vectors = JSON.parse(
      readFileSync(new URL("digest-vectors.json", here), "utf8"),
    ) as Vector[];
    const out = vectors.map((vector) => {
      const params = parseWwwAuthenticate(vector.header);
      cnonce.hex = vector.cnonce;
      try {
        const authorization = buildDigestAuthorization({ ...vector, challenge: params });
        return { name: vector.name, params, authorization };
      } catch (error) {
        return { name: vector.name, params, error: (error as Error).message };
      }
    });
    const text = `${JSON.stringify(out, null, 2)}\n`;
    const oracle = new URL("node-oracle-digest.json", here);
    if (process.env.UPDATE_PRUSALINK_ORACLE) {
      writeFileSync(oracle, text);
      return;
    }
    expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(oracle, "utf8")));
  });
});
