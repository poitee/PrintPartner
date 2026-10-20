// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { openSponsor } from "./supportLinks";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function nativeBridge(value: () => Promise<void>): void {
  Object.defineProperty(window, "__PRINT_PARTNER_NATIVE_SPONSOR__", { value, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(window, "__PRINT_PARTNER_NATIVE_SPONSOR__");
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Sponsor action", () => {
  it("opens the fixed Sponsors page in ordinary browsers", () => {
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    openSponsor();
    expect(popup).toHaveBeenCalledExactlyOnceWith("https://github.com/sponsors/poitee", "_blank", "noopener,noreferrer");
  });

  it("calls only the nullary native action when injected", async () => {
    const native = vi.fn().mockResolvedValue(undefined);
    nativeBridge(native);
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    openSponsor();
    await vi.waitFor(() => expect(native).toHaveBeenCalledExactlyOnceWith());
    expect(popup).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([false, true])("shows a useful error without popup fallback when native failure is synchronous: %s", async (synchronous) => {
    nativeBridge(() => {
      if (synchronous) throw new Error("denied");
      return Promise.reject(new Error("denied"));
    });
    const popup = vi.spyOn(window, "open").mockReturnValue(null);
    openSponsor();
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      "Could not confirm your browser opened. Visit github.com/sponsors/poitee to sponsor Print Partner.",
    ));
    expect(popup).not.toHaveBeenCalled();
  });
});
