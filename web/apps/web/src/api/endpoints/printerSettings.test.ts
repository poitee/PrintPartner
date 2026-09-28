import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  fetchPrinterProfileAssignment,
  savePrinterProfileAssignment,
} from "./printerSettings";

const http = createEndpointTestHttp();

describe("printer settings endpoints", () => {

  it("reads and saves printer profile assignments", async () => {
    const assignment = {
      printer_id: "printer",
      profile_source: "assigned",
      machine_profile_id: 4,
      filament_slots: [{ slot_index: 0, filament_profile_id: 8 }],
      last_synced_at: null,
      compatible_processes: [],
    };
    http.respond(jsonResponse(assignment)).respond(jsonResponse(assignment));

    await expect(fetchPrinterProfileAssignment("printer/id")).resolves.toEqual(
      assignment,
    );
    await savePrinterProfileAssignment("printer/id", {
      profile_source: "assigned",
      machine_profile_id: 4,
      filament_slots: [{ slot_index: 0, filament_profile_id: 8 }],
    });

    expect(http.calls[0]?.[0]).toContain(
      "/printers/printer%2Fid/profile-assignment",
    );
    expect(http.requestJson(1)).toEqual({
      profile_source: "assigned",
      machine_profile_id: 4,
      filament_slots: [{ slot_index: 0, filament_profile_id: 8 }],
    });
  });
});
