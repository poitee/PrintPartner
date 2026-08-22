import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_PRINTER_STATUS_POLL_SECONDS,
  parsePrinterStatusPollSeconds,
  printerStatusPollMs,
  readPrinterStatusPollSeconds,
  writePrinterStatusPollSeconds,
} from "./persistedPrinterStatusPoll";

describe("persistedPrinterStatusPoll", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to 5 seconds", () => {
    expect(parsePrinterStatusPollSeconds(null)).toBe(DEFAULT_PRINTER_STATUS_POLL_SECONDS);
    expect(parsePrinterStatusPollSeconds("")).toBe(5);
    expect(parsePrinterStatusPollSeconds("7")).toBe(5);
    expect(readPrinterStatusPollSeconds()).toBe(5);
  });

  it("accepts only 5 / 10 / 15 / 30", () => {
    expect(parsePrinterStatusPollSeconds("5")).toBe(5);
    expect(parsePrinterStatusPollSeconds("10")).toBe(10);
    expect(parsePrinterStatusPollSeconds("15")).toBe(15);
    expect(parsePrinterStatusPollSeconds("30")).toBe(30);
    expect(parsePrinterStatusPollSeconds("60")).toBe(5);
  });

  it("persists and converts to ms", () => {
    writePrinterStatusPollSeconds(15);
    expect(readPrinterStatusPollSeconds()).toBe(15);
    expect(printerStatusPollMs(15)).toBe(15_000);
  });
});
