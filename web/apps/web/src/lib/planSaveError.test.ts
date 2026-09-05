import { describe, expect, it } from "vitest";
import { EngineHttpError } from "../api/engineTransport";
import { planSaveError } from "./planSaveError";

describe("Plan save errors", () => {
  it("does not mistake missing files for a conflict with a print", () => {
    expect(planSaveError(new EngineHttpError("Request failed", 422, { code: "no_stls" }))).toContain("Sync or upload files");
  });
  it("explains the protection for a recorded print", () => {
    expect(planSaveError(new EngineHttpError("Request failed", 422, { code: "checkoff_remap_unsafe" }))).toContain("recorded or queued print");
  });
  it("preserves useful unexpected errors", () => {
    expect(planSaveError(new Error("Connection lost"))).toBe("Connection lost");
  });
});
