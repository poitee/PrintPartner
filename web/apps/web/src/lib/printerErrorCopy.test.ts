import { describe, expect, it } from "vitest";
import {
  isPrinterAuthUnavailable,
  quietPrinterLoadError,
  quietPrinterStatusMessage,
} from "./printerErrorCopy";

describe("printerErrorCopy", () => {
  it("quiets 401 Engine paths", () => {
    const msg = "Engine /api/v1/printers failed: 401";
    expect(isPrinterAuthUnavailable(msg)).toBe(true);
    expect(quietPrinterLoadError(msg)).toEqual({
      quiet: true,
      text: "Printers unavailable",
    });
  });

  it("strips /api paths from status messages", () => {
    expect(
      quietPrinterStatusMessage("Engine /api/v1/integrations/x/status failed: 401"),
    ).toBe("Printers unavailable");
  });

  it("strips unversioned and v2 Engine /api paths without leaving /api/", () => {
    const v2 = quietPrinterStatusMessage(
      "Engine /api/v2/integrations/x/status failed: connection refused",
    );
    expect(v2).toBeTruthy();
    expect(v2).not.toMatch(/\/api\//i);
    expect(v2).not.toMatch(/Engine/i);

    const bare = quietPrinterStatusMessage(
      "Upstream error at /api/printers/status — try again",
    );
    expect(bare).toBeTruthy();
    expect(bare).not.toMatch(/\/api\//i);
  });
});
