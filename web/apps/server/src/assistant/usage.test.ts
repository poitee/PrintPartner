import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import {
  checkDailyBudget,
  estimateTokens,
  loadDailyUsage,
  recordDailyUsage,
  utcDayKey,
} from "./usage.js";

describe("assistant daily usage caps", () => {
  let dataDir: string;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-ai-usage-"));
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("estimateTokens uses chars/4", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });

  it("records and loads same-day usage", () => {
    expect(loadDailyUsage(repo).requests).toBe(0);
    recordDailyUsage(repo, 100);
    recordDailyUsage(repo, 50);
    const usage = loadDailyUsage(repo);
    expect(usage.date).toBe(utcDayKey());
    expect(usage.requests).toBe(2);
    expect(usage.tokens).toBe(150);
  });

  it("enforces request budget with a clear message", () => {
    recordDailyUsage(repo, 10);
    recordDailyUsage(repo, 10);
    const gate = checkDailyBudget(
      repo,
      { requestBudget: 2, tokenBudget: 0 },
      50,
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.detail).toMatch(/request budget exceeded/i);
      expect(gate.detail).toMatch(/2\/2/);
    }
  });

  it("enforces token budget before the turn would exceed it", () => {
    recordDailyUsage(repo, 900);
    const gate = checkDailyBudget(
      repo,
      { requestBudget: 0, tokenBudget: 1000 },
      200,
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.detail).toMatch(/token budget exceeded/i);
    }
  });

  it("allows unlimited budgets (0)", () => {
    for (let i = 0; i < 5; i += 1) recordDailyUsage(repo, 10_000);
    const gate = checkDailyBudget(
      repo,
      { requestBudget: 0, tokenBudget: 0 },
      50_000,
    );
    expect(gate.ok).toBe(true);
  });
});
