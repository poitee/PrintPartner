// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrinterQueueSuggestionBanner from "./PrinterQueueSuggestionBanner";

const api = vi.hoisted(() => ({
  drainPrinterSendQueue: vi.fn(),
}));

vi.mock("../../api/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/engine")>()),
  ...api,
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.drainPrinterSendQueue.mockResolvedValue({ results: [] });
});

afterEach(cleanup);

const suggestions = [
  {
    printer_id: "printer-one",
    printer_name: "Printer One",
    integration_id: "host-one",
    items: [],
    item_count: 1,
  },
  {
    printer_id: "printer-two",
    printer_name: "Printer Two",
    integration_id: "host-two",
    items: [],
    item_count: 1,
  },
];

function ParentOwnedSuggestions() {
  const [current, setCurrent] = useState(suggestions);
  return (
    <>
      <button type="button" onClick={() => setCurrent(suggestions)}>
        Refetch suggestions
      </button>
      <PrinterQueueSuggestionBanner
        suggestions={current}
        onDrained={(printerId) =>
          setCurrent((existing) =>
            printerId === undefined
              ? []
              : existing.filter((suggestion) => suggestion.printer_id !== printerId),
          )
        }
      />
    </>
  );
}

describe("PrinterQueueSuggestionBanner", () => {
  it("scopes a row send to that Printer and keeps other suggestions visible", async () => {
    render(<ParentOwnedSuggestions />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send queued plates to Printer One" }),
    );

    await waitFor(() => {
      expect(api.drainPrinterSendQueue).toHaveBeenCalledWith({
        printer_id: "printer-one",
      });
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Send queued plates to Printer One" }),
      ).toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "Send queued plates to Printer Two" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refetch suggestions" }));

    expect(
      screen.getByRole("button", { name: "Send queued plates to Printer One" }),
    ).toBeTruthy();
  });

  it("keeps Send all unscoped", async () => {
    render(<PrinterQueueSuggestionBanner suggestions={suggestions} />);

    fireEvent.click(screen.getByRole("button", { name: "Send all" }));

    await waitFor(() => {
      expect(api.drainPrinterSendQueue).toHaveBeenCalledWith(undefined);
    });
  });
});
