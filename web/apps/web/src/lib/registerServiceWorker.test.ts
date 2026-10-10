// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./registerServiceWorker";

function stubServiceWorker() {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn() },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

it("registers a load listener outside the desktop build", () => {
  stubServiceWorker();
  vi.stubEnv("VITE_PRINT_PARTNER_DESKTOP", "");
  const listener = vi.spyOn(window, "addEventListener");
  registerServiceWorker();
  expect(listener).toHaveBeenCalledWith("load", expect.any(Function));
});

it("does not register a service worker in the trusted desktop build", () => {
  stubServiceWorker();
  vi.stubEnv("VITE_PRINT_PARTNER_DESKTOP", "1");
  const listener = vi.spyOn(window, "addEventListener");
  registerServiceWorker();
  expect(listener).not.toHaveBeenCalled();
});
