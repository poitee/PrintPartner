// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./registerServiceWorker";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("does not register a service worker in the trusted desktop build", () => {
  vi.stubEnv("VITE_PRINT_PARTNER_DESKTOP", "1");
  const listener = vi.spyOn(window, "addEventListener");
  registerServiceWorker();
  expect(listener).not.toHaveBeenCalled();
});
