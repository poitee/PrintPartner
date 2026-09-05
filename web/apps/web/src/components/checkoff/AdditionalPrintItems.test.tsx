// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PrinterCheckoffLink } from "@print-partner/contracts";
import AdditionalPrintItems from "./AdditionalPrintItems";

afterEach(cleanup);
it("prints grouped copies, checked results, and unknown file quantity after verification", () => {
  const link: PrinterCheckoffLink = {
    id: "extra", profile_id: 1, integration_id: "manual", printer_id: "manual", host_name: "Manual",
    filename: "plate.bgcode", units: [], state: "verified", saw_active: false, created_at: "2026-09-05",
    imported_inventory: { extras: [
      { name: "clip.stl", kind: "object", checkoff: { result: "confirmed", checked_at: "2026-09-05" } },
      { name: "clip.stl", kind: "object", checkoff: { result: "confirmed", checked_at: "2026-09-05" } },
      { name: "unknown.bgcode", kind: "file", checkoff: { result: "pending" } },
    ] },
  };
  render(<AdditionalPrintItems links={[link]} />);
  expect(screen.getByText("clip.stl").closest("tr")?.textContent).toBe("clip.stl2Checked");
  expect(screen.getByText("unknown.bgcode").closest("tr")?.textContent).toContain("Unknown");
  expect(screen.getByText("plate.bgcode · Manual")).toBeTruthy();
});
