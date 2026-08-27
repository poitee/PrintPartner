import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  claimUnattributedPrint,
  dismissPrinterCheckoff,
  dismissUnattributedPrint,
  fetchCheckoff,
  fetchPartAssembled,
  fetchPrintOutcomesSummary,
  fetchPrinterCheckoffLinks,
  fetchUnattributedPrints,
  patchPartAssembled,
  patchPartProgress,
  reconcilePrinterCheckoff,
  verifyPrinterCheckoff,
} from "./checkoff";

const http = createEndpointTestHttp();

describe("checkoff endpoints", () => {
  it("reconciles, lists, verifies, dismisses, and summarizes printer checkoff", async () => {
    http
      .respond(
        jsonResponse({
          status: { state: "idle" },
          updates: [],
          created_links: [],
          applied: [],
        }),
      )
      .respond(jsonResponse({ links: [] }))
      .respond(
        jsonResponse({
          link: { id: "link" },
          units_confirmed: 1,
          units_rejected: 0,
          outcomes: [],
        }),
      )
      .respond(jsonResponse({ link: { id: "link" } }))
      .respond(
        jsonResponse({
          profile_id: 7,
          total_confirmed: 1,
          total_rejected: 0,
          by_reason: {},
          by_role: {},
          recent_rejected: [],
        }),
      );

    await reconcilePrinterCheckoff({ integration_id: "host" });
    await fetchPrinterCheckoffLinks({
      state: "awaiting_verify",
      profile_id: 7,
      integration_id: "host",
    });
    await verifyPrinterCheckoff({
      link_id: "link",
      decisions: [{ part_id: 1, unit_index: 0, result: "confirmed" }],
    });
    await dismissPrinterCheckoff({ link_id: "link" });
    await fetchPrintOutcomesSummary(7);

    expect(http.requestJson(0)).toEqual({ integration_id: "host" });
    expect(http.calls[1]?.[0]).toContain("state=awaiting_verify");
    expect(http.calls[1]?.[0]).toContain("profile_id=7");
    expect(http.requestJson(2)).toEqual({
      link_id: "link",
      decisions: [{ part_id: 1, unit_index: 0, result: "confirmed" }],
    });
    expect(http.requestJson(3)).toEqual({ link_id: "link" });
    expect(http.calls[4]?.[0]).toContain(
      "/printer-outcomes/summary?profile_id=7",
    );
  });

  it("reads and patches legacy part checkoff state", async () => {
    http
      .respond(jsonResponse({ summary: "0/1", parts: [] }))
      .respond(jsonResponse({ part: { id: 1 }, summary: "1/1" }))
      .respond(jsonResponse({ part: { id: 1 }, summary: "1/1" }))
      .respond(jsonResponse({ assembled: true, part: { id: 1 } }));

    await fetchCheckoff(7);
    await patchPartProgress(1, 2, true);
    await patchPartAssembled(1, 2, true);
    await fetchPartAssembled(1);

    expect(http.calls[0]?.[0]).toContain("/plans/7/checkoff");
    expect(http.requestJson(1)).toEqual({ unit_index: 2, completed: true });
    expect(http.requestJson(2)).toEqual({ unit_index: 2, assembled: true });
    expect(http.calls[3]?.[0]).toContain("/parts/1/assembled");
  });

  it("lists, claims, and dismisses unattributed prints", async () => {
    http
      .respond(jsonResponse({ prints: [] }))
      .respond(jsonResponse({ ok: true, link: { id: "link" } }))
      .respond(jsonResponse({ ok: true }));

    await expect(fetchUnattributedPrints()).resolves.toEqual([]);
    await claimUnattributedPrint("print/id", 7, {
      selected_stl_basenames: ["part.stl"],
    });
    await dismissUnattributedPrint("print/id");

    expect(http.calls[0]?.[0]).toContain("/printer-checkoff/unattributed");
    expect(http.calls[1]?.[0]).toContain(
      "/printer-checkoff/unattributed/print%2Fid/claim",
    );
    expect(http.requestJson(1)).toEqual({
      profile_id: 7,
      selected_stl_basenames: ["part.stl"],
    });
    expect(http.calls[2]?.[0]).toContain(
      "/printer-checkoff/unattributed/print%2Fid/dismiss",
    );
  });
});
