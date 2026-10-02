import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDesktopPrincipal } from "./desktop-context.js";

const setup = { key: "ab".repeat(32), generation: "cd".repeat(16) };
const principal = { version: 1, generation: setup.generation, tenant: "default", actor: "desktop-owner",
  method: "POST", target: "/plans/1/save?expected=2", issued_at: 100_000 };
function signed(value: unknown) {
  const encoded = Buffer.from(JSON.stringify(value)).toString("hex");
  return { encoded, signature: createHmac("sha256", Buffer.from(setup.key, "hex")).update(encoded).digest("hex"),
    method: principal.method, target: principal.target, now: 100_500 };
}

describe("desktop principal boundary", () => {
  it("accepts the exact authenticated request context", () => {
    expect(verifyDesktopPrincipal(signed(principal), setup)).toEqual(principal);
  });
  it.each([
    { version: 2 }, { generation: "ef".repeat(16) }, { tenant: "other" }, { actor: "other" },
    { method: "GET" }, { target: "/plans/2/save?expected=2" }, { target: "/plans/1/save?expected=3" },
    { issued_at: 1 }, { issued_at: 200_000 },
  ])("rejects a signed assertion with changed context %j", (changed) => {
    expect(() => verifyDesktopPrincipal(signed({ ...principal, ...changed }), setup)).toThrow();
  });
  it("rejects missing, forged and previous-generation signatures", () => {
    expect(() => verifyDesktopPrincipal({ ...signed(principal), encoded: undefined }, setup)).toThrow();
    expect(() => verifyDesktopPrincipal({ ...signed(principal), signature: "00".repeat(32) }, setup)).toThrow();
    expect(() => verifyDesktopPrincipal(signed(principal), { ...setup, key: "fe".repeat(32) })).toThrow();
  });
});

it("arbitrates standalone writers through an exclusive marker", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { acquireDataDirectory } = await import("./desktop-context.js");
  const directory = mkdtempSync(join(tmpdir(), "pp-owner-test-"));
  try {
    const release = acquireDataDirectory(directory);
    expect(() => acquireDataDirectory(directory)).toThrow("owned by the desktop runtime");
    release();
    release();
    acquireDataDirectory(directory)();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
