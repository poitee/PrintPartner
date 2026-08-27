import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  parseArrangeAcceptedPlatesRequest,
  parseInitializeAcceptedPlatesRequest,
  parsePinAcceptedPlateUnitRequest,
  parseRestoreAcceptedPlatesRequest,
  parseStartDirectExportRequest,
  parseTransferAcceptedPlateUnitRequest,
  parseUnplaceAcceptedPlateUnitRequest,
} from "@print-partner/contracts";
import {
  arrangeAcceptedPlates,
  fetchAcceptedPlateExportJobs,
  fetchAcceptedPlateSlicerExchangeStatus,
  fetchAcceptedPlateWorkspace,
  initializeAcceptedPlates,
  moveAcceptedPlateUnit,
  pinAcceptedPlateUnit,
  restoreAcceptedPlates,
  openAcceptedPlatesInSlicer,
  startAcceptedPlateExport,
  startDirectExport,
  transferAcceptedPlateUnit,
  unplaceAcceptedPlateUnit,
} from "./acceptedPlates";

const digest = "a".repeat(64);
const token = `ppu_${"b".repeat(32)}`;
const plateId = `plate_${"c".repeat(32)}`;
const basis = {
  profile_id: 7,
  plan_version: 3,
  plan_revision_id: 11,
  plan_revision_digest: digest,
  required_unit_mapping_digest: digest,
};

const http = createEndpointTestHttp();

describe("accepted Plate endpoints", () => {
  it("uses exact root workspace routes and parsed bodies", async () => {
    http
      .respond(jsonResponse({ kind: "empty_plan" }))
      .respond(jsonResponse({ kind: "empty_plan" }))
      .respond(
        jsonResponse({ plate_revision_id: 20, plate_revision_number: 4 }),
      );

    await fetchAcceptedPlateWorkspace(7);
    await initializeAcceptedPlates(
      7,
      parseInitializeAcceptedPlatesRequest({
        expected: basis,
        expected_plate_revision_id: null,
        assignments: [{ token, printer_id: "printer-one" }],
      }),
    );
    await moveAcceptedPlateUnit(7, plateId, token, {
      expected: basis,
      expected_plate_revision_id: 19,
      x_um: 12_345,
      y_um: 20_000,
    });

    expect(
      http.calls.map(([url, init]) => [url, init?.method, init?.body]),
    ).toEqual([
      ["/plans/7/plates", "GET", undefined],
      [
        "/plans/7/plates/initialize",
        "POST",
        JSON.stringify({
          expected: basis,
          expected_plate_revision_id: null,
          assignments: [{ token, printer_id: "printer-one" }],
        }),
      ],
      [
        `/plans/7/plates/${plateId}/units/${token}`,
        "PATCH",
        JSON.stringify({
          expected: basis,
          expected_plate_revision_id: 19,
          x_um: 12_345,
          y_um: 20_000,
        }),
      ],
    ]);
  });

  it("uses root export and handoff routes plus only the v1 recent-job list", async () => {
    http
      .respond(jsonResponse({ job_id: "job-one" }))
      .respond(jsonResponse({ jobs: [] }))
      .respond(
        jsonResponse({
          gui_url: "http://127.0.0.1:8080",
          plate_revision_id: 19,
          plate_revision_number: 3,
          layout_digest: digest,
          inbox_relative_path: "instance/revision-19",
          staged: [{ ordinal: 1, filename: "plate-0001.3mf" }],
          download_url: "/exports/accepted/revision-19/bundle.zip",
          local_app: { scheme_attempt: null, note: "Download the file." },
        }),
      );

    await startAcceptedPlateExport({
      profile_id: 7,
      expected_plate_revision_id: 19,
    });
    await fetchAcceptedPlateExportJobs(7);
    await openAcceptedPlatesInSlicer("orca local", {
      profile_id: 7,
      expected_plate_revision_id: 19,
    });

    const urls = http.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "/jobs/export-accepted-plate-3mf",
      "/api/v1/jobs?profile_id=7",
      "/slicer-instances/orca%20local/open-accepted-plates",
    ]);
    expect(urls.every((url) => !url.startsWith("/api/v2/jobs"))).toBe(true);
  });

  it("uses the strict accepted Plate edit routes and bodies", async () => {
    const receipt = { plate_revision_id: 20, plate_revision_number: 4 };
    http
      .respond(jsonResponse(receipt))
      .respond(
        jsonResponse({
          ...receipt,
          plate_revision_id: 21,
          plate_revision_number: 5,
        }),
      )
      .respond(
        jsonResponse({
          ...receipt,
          plate_revision_id: 22,
          plate_revision_number: 6,
        }),
      )
      .respond(jsonResponse({ kind: "empty_plan" }))
      .respond(jsonResponse({ kind: "empty_plan" }));

    await pinAcceptedPlateUnit(
      7,
      plateId,
      token,
      parsePinAcceptedPlateUnitRequest({
        expected: basis,
        expected_plate_revision_id: 19,
        pinned: true,
      }),
    );
    await unplaceAcceptedPlateUnit(
      7,
      plateId,
      token,
      parseUnplaceAcceptedPlateUnitRequest({
        expected: basis,
        expected_plate_revision_id: 20,
      }),
    );
    await transferAcceptedPlateUnit(
      7,
      plateId,
      token,
      parseTransferAcceptedPlateUnitRequest({
        expected: basis,
        expected_plate_revision_id: 21,
        target_printer_id: "printer-two",
      }),
    );
    await arrangeAcceptedPlates(
      7,
      parseArrangeAcceptedPlatesRequest({
        expected: basis,
        expected_plate_revision_id: 22,
        mode: "all",
      }),
    );
    await restoreAcceptedPlates(
      7,
      parseRestoreAcceptedPlatesRequest({
        expected: basis,
        expected_plate_revision_id: 23,
        restore_plate_revision_id: 19,
      }),
    );

    expect(
      http.calls.map(([url, init]) => [url, init?.method, init?.body]),
    ).toEqual([
      [
        `/plans/7/plates/${plateId}/units/${token}/pin`,
        "PATCH",
        JSON.stringify({
          expected: basis,
          expected_plate_revision_id: 19,
          pinned: true,
        }),
      ],
      [
        `/plans/7/plates/${plateId}/units/${token}/unplace`,
        "POST",
        JSON.stringify({
          expected: basis,
          expected_plate_revision_id: 20,
        }),
      ],
      [
        `/plans/7/plates/${plateId}/units/${token}/transfer`,
        "POST",
        JSON.stringify({
          expected: basis,
          expected_plate_revision_id: 21,
          target_printer_id: "printer-two",
        }),
      ],
      [
        "/plans/7/plates/arrange",
        "POST",
        JSON.stringify({
          expected: basis,
          expected_plate_revision_id: 22,
          mode: "all",
        }),
      ],
      [
        "/plans/7/plates/restore",
        "POST",
        JSON.stringify({
          expected: basis,
          expected_plate_revision_id: 23,
          restore_plate_revision_id: 19,
        }),
      ],
    ]);
  });

  it("parses only coarse slicer exchange status without server detail", async () => {
    http.respond(jsonResponse({ ready: false, code: "unavailable" }));

    await expect(fetchAcceptedPlateSlicerExchangeStatus()).resolves.toEqual({
      ready: false,
      code: "unavailable",
    });
    expect(http.request()).toMatchObject({
      url: "/slicer-handoff/exchange-status",
      method: "GET",
    });
  });

  it("preserves the bounded unit_not_found move failure", async () => {
    http.respond(
      jsonResponse(
        {
          code: "unit_not_found",
          detail: "/private/server/path",
        },
        422,
      ),
    );

    await expect(
      moveAcceptedPlateUnit(7, plateId, token, {
        expected: basis,
        expected_plate_revision_id: 19,
        x_um: 12_345,
        y_um: 20_000,
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "endpoint",
        status: 422,
        error: { code: "unit_not_found" },
      },
    });
  });

  it("starts Direct export on the unarranged 3MF job", async () => {
    http.respond(jsonResponse({ job_id: "job-direct" }));

    await expect(
      startDirectExport(
        parseStartDirectExportRequest({
          profile_id: 7,
          tokens: [token],
        }),
      ),
    ).resolves.toBe("job-direct");
    expect(
      http.calls.map(([url, init]) => [url, init?.method, init?.body]),
    ).toEqual([
      [
        "/jobs/export-direct-3mf",
        "POST",
        JSON.stringify({ profile_id: 7, tokens: [token] }),
      ],
    ]);
  });
});
