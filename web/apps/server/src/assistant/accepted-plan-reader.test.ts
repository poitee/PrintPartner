import { describe, expect, it, vi } from "vitest";
import { readAcceptedPlanForAssistant } from "./accepted-plan-reader.js";
import { AcceptedPlanOperationalIntegrityError } from "../db/accepted-plan-operational.js";
import type { AppRepository } from "../db/repository.js";

function repoStub(overrides: Record<string, unknown>): AppRepository {
  return overrides as unknown as AppRepository;
}

const identity = { id: 7, name: "Build", orderNumber: null, archivedAt: null };

describe("readAcceptedPlanForAssistant", () => {
  it("returns missing when the plan identity is absent", () => {
    const repo = repoStub({ getOwnedProfileIdentity: vi.fn(() => null) });

    expect(readAcceptedPlanForAssistant(repo, 7)).toEqual({ kind: "missing" });
  });

  it("returns identity and accepted snapshot when readable", () => {
    const snapshot = { basis: { profile_id: 7 } };
    const repo = repoStub({
      getOwnedProfileIdentity: vi.fn(() => identity),
      readAcceptedPlanOperationalSnapshot: vi.fn(() => snapshot),
    });

    expect(readAcceptedPlanForAssistant(repo, 7)).toEqual({
      kind: "read",
      identity,
      accepted: snapshot,
    });
  });

  it("maps accepted-plan integrity failures to a safe assistant-facing message", () => {
    const repo = repoStub({
      getOwnedProfileIdentity: vi.fn(() => identity),
      readAcceptedPlanOperationalSnapshot: vi.fn(() => {
        throw new AcceptedPlanOperationalIntegrityError("progress", "bad");
      }),
    });

    expect(readAcceptedPlanForAssistant(repo, 7)).toEqual({
      kind: "failure",
      detail: "Accepted Plan data is inconsistent",
    });
  });

  it("maps unexpected read failures to a generic message", () => {
    const repo = repoStub({
      getOwnedProfileIdentity: vi.fn(() => {
        throw new Error("boom");
      }),
    });

    expect(readAcceptedPlanForAssistant(repo, 7)).toEqual({
      kind: "failure",
      detail: "Internal Server Error",
    });
  });
});
