import { acceptPlanForTest, editAcceptedPartsForTest } from "../test/accept-plan.js";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { strToU8 } from "fflate";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { registerPrinterCheckoffRoutes } from "./printer-checkoff.js";
import {
  bgcode,
  hostileZip,
  slicedThreeMf,
  slicerProjectThreeMf,
} from "../test/print-file-fixtures.js";
import { createIntegrationPort, type PrinterFileAccess } from "../integrations/store.js";
import {
  isManualIntegrationId,
  UNMANAGED_PRINTER_ID,
  UNMANAGED_PRINTER_NAME,
  type PrinterStorageEntry,
} from "@print-partner/contracts";
import { getIntegrationAdapter } from "../integrations/registry.js";
import {
  createPrinterCheckoffLink,
  getPrinterCheckoffLink,
  loadPrinterCheckoffLinks,
  updatePrinterCheckoffLink,
} from "../services/printer-checkoff-store.js";
import {
  observePrinterCheckoffFileDrift,
  reconcilePrinterCheckoff,
} from "../services/printer-checkoff.js";
import {
  createUnattributedPrint,
  listUnattributedPrints,
  saveUnattributedPrint,
} from "../services/unattributed-print-store.js";
import { AcceptedPlanOperationalIntegrityError } from "../db/accepted-plan-operational.js";
import { loadFleet, parsePrinterMachine, saveFleet } from "../services/printer-fleet.js";
import { MAX_CLASSIFIABLE_BYTES } from "../lib/print-file-classification.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pp-printer-checkoff-progress-"));
  const sqlite = new SqliteDatabase(dir);
  sqlite.connect();
  const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
  const source = repo.createSource({ name: "Repo", url: "https://github.com/a/b" });
  const repoPath = join(dir, "repos", String(source.id));
  mkdirSync(join(repoPath, "parts"), { recursive: true });
  writeFileSync(join(repoPath, "parts", "bracket.stl"), "solid");
  repo.updateSource(source.id, { local_path: repoPath });
  repo.updateImportRules(source.id, ["parts/"]);
  const plan = repo.createProfile("Progress", source.id);
  acceptPlanForTest(repo, plan.id);
  const priorBracket = repo.listParts(plan.id).parts.find((p) => p.filename === "bracket.stl")!;
  const remapped = editAcceptedPartsForTest(repo, plan.id, [{
    projectionPartId: priorBracket.id,
    quantityOverride: 1,
  }]);
  const bracket = repo.getPartRow(remapped.get(priorBracket.id)!)!;
  repo.setSetting("integrations", JSON.stringify([{
    id: "prusa-1",
    type: "prusalink",
    name: "Core One",
    config: { base_url: "http://127.0.0.1", username: "maker", password: "secret" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }]));
  repo.setSetting("printer.plan_bindings", JSON.stringify([{
    integration_id: "prusa-1",
    profile_id: plan.id,
    updated_at: new Date().toISOString(),
  }]));

  const integrations = createIntegrationPort({ repo, getAdapter: getIntegrationAdapter });
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  // Same limits app.ts registers, so the route's own per-request caps are what
  // the tests exercise.
  await app.register(multipart, { limits: { fileSize: Infinity, files: 100, parts: 101 } });
  await registerPrinterCheckoffRoutes(app, { repo, integrations });
  await app.register(
    async (v1) => registerPrinterCheckoffRoutes(v1, { repo, integrations }),
    { prefix: "/api/v1" },
  );
  const accepted = repo.readAcceptedPlanOperationalSnapshot(plan.id);
  if (accepted.kind !== "ready") throw new Error("accepted fixture is unavailable");
  const acceptedPart = accepted.snapshot.parts.find(
    (part) => part.projectionPartId === bracket.id,
  )!;
  cleanup.push(async () => {
    await app.close();
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    app,
    repo,
    plan,
    bracket,
    repoPath,
    acceptedPart,
    planRevisionId: accepted.snapshot.revisionId,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function acceptedPrintUnits(repo: AppRepository, profileId: number, partId: number): boolean[] {
  const accepted = repo.readAcceptedPlanOperationalSnapshot(profileId);
  if (accepted.kind !== "ready") throw new Error("accepted fixture is unavailable");
  return accepted.snapshot.parts
    .find((part) => part.projectionPartId === partId)
    ?.units.map((unit) => unit.completed) ?? [];
}

/**
 * Build a multipart body by hand, so the upload tests exercise the same wire
 * bytes a browser sends rather than a mocked parser.
 */
function multipartUpload(input: {
  fields?: Record<string, string>;
  file?: { fieldname?: string; filename: string; bytes: Uint8Array };
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----printpartnertestboundary";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (input.file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${input.file.fieldname ?? "file"}";` +
          ` filename="${input.file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(input.file.bytes),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("printer progress route", () => {
  it("allows the default polling load from two browsers and three printers", async () => {
    const { app } = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => response({ printer: { state: "IDLE" } })));

    const statuses: number[] = [];
    for (let requestNumber = 0; requestNumber < 72; requestNumber += 1) {
      const reconcile = await app.inject({
        method: "POST",
        url: "/printer-checkoff/reconcile",
        payload: { integration_id: "prusa-1" },
      });
      statuses.push(reconcile.statusCode);
    }

    expect(statuses).toEqual(Array.from({ length: 72 }, () => 200));
  });

  it("maps a currently printing Required-unit Object name without mutable Part reads", async () => {
    const { app, repo, plan, acceptedPart } = await setup();
    const mutableParts = vi.spyOn(repo, "getProfilePartRows");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/status")) {
        return response({
          printer: { state: "PRINTING" },
          job: { progress: 42, file: { display_name: "bracket.bgcode" } },
        });
      }
      if (url.includes("/api/v1/job")) {
        return response({
          state: "PRINTING",
          file: { display_name: "bracket.bgcode" },
          refs: { download: "/usb/bracket.bgcode" },
        });
      }
      if (url.includes("/usb/bracket.bgcode")) {
        return new Response(
          `objects_info={"objects":[{"name":"${acceptedPart.units[0]!.objectName}"}]}`,
          { status: 206 },
        );
      }
      return response({});
    }));

    const reconcile = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });
    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.json()).toMatchObject({
      status: { state: "printing", filename: "bracket.bgcode" },
      updates: [],
      created_links: [{
        profile_id: plan.id,
        filename: "bracket.bgcode",
        units: [{ part_id: expect.any(Number), unit_index: 0 }],
      }],
    });

    const watching = await app.inject({
      method: "GET",
      url: `/printer-checkoff?state=watching&profile_id=${plan.id}`,
    });
    expect(watching.json()).toMatchObject({
      links: [{
        filename: "bracket.bgcode",
        units: [{ part_id: expect.any(Number), unit_index: 0 }],
      }],
    });
    expect(mutableParts).not.toHaveBeenCalled();
  });

  it("durably repairs a legacy zero-unit awaiting card before returning it", async () => {
    const { app, repo, plan, bracket } = await setup();
    const link = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "bracket.bgcode",
    });
    const stale = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      ["bracket_01"],
      [],
    );
    saveUnattributedPrint(repo, stale);
    const setSetting = vi.spyOn(repo, "setSetting");

    const awaiting = await app.inject({
      method: "GET",
      url: `/printer-checkoff?state=awaiting_verify&profile_id=${plan.id}`,
    });
    expect(awaiting.json()).toMatchObject({
      links: [{
        id: link.id,
        units: [{ part_id: bracket.id, unit_index: 0 }],
      }],
    });
    expect(getPrinterCheckoffLink(repo, link.id)?.units).toEqual([
      { part_id: bracket.id, unit_index: 0 },
    ]);
    expect(setSetting).toHaveBeenCalled();
    const storedPrint = listUnattributedPrints(repo).find((p) => p.id === stale.id);
    expect(storedPrint?.claimed_at).toBeUndefined();
    expect(storedPrint?.claimed_profile_id).toBeUndefined();
  });

  it("does not repair an empty link outside the requested Plan and integration", async () => {
    const { app, repo, plan } = await setup();
    const otherPlan = repo.createProfile("Other Plan");
    const link = createPrinterCheckoffLink(repo, {
      profile_id: otherPlan.id,
      integration_id: "prusa-2",
      printer_id: "other-printer",
      host_name: "Other Printer",
      filename: "bracket.bgcode",
      units: [],
      unlabeled_names: ["bracket.stl"],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-2", {
      state: "complete",
      filename: "bracket.bgcode",
    });
    const before = repo.getSetting("printer.checkoff_links");
    const materialize = vi.spyOn(repo, "materializeAcceptedPrinterLink");
    const writes = vi.spyOn(repo, "setSetting");

    const result = await app.inject({
      method: "GET",
      url: `/printer-checkoff?profile_id=${plan.id}&integration_id=prusa-1`,
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ links: [] });
    expect(materialize).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(repo.getSetting("printer.checkoff_links")).toBe(before);
    expect(getPrinterCheckoffLink(repo, link.id)?.units).toEqual([]);
  });

  it("does not repair awaiting links for a terminal-state request", async () => {
    const { app, repo, plan, bracket } = await setup();
    const awaiting = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [],
      unlabeled_names: ["bracket.stl"],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "bracket.bgcode",
    });
    const terminal = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-2",
      printer_id: "core-two",
      host_name: "Core Two",
      filename: "done.bgcode",
      units: [{ part_id: bracket.id, unit_index: 0 }],
    })!;
    updatePrinterCheckoffLink(repo, terminal.id, { state: "verified" });
    const before = repo.getSetting("printer.checkoff_links");
    const materialize = vi.spyOn(repo, "materializeAcceptedPrinterLink");
    const writes = vi.spyOn(repo, "setSetting");

    const result = await app.inject({
      method: "GET",
      url: "/printer-checkoff?state=verified",
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ links: [{ id: terminal.id, state: "verified" }] });
    expect(materialize).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(repo.getSetting("printer.checkoff_links")).toBe(before);
    expect(getPrinterCheckoffLink(repo, awaiting.id)?.units).toEqual([]);
  });

  it("returns a stored empty link when durable repair finds no match", async () => {
    const { app, repo, plan } = await setup();
    const link = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "unknown.bgcode",
      units: [],
      unlabeled_names: ["not-a-library-part"],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "unknown.bgcode",
    });
    const getProfilePartRows = vi.spyOn(repo, "getProfilePartRows");
    const setSetting = vi.spyOn(repo, "setSetting");
    let now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);

    const first = await app.inject({
      method: "GET",
      url: `/printer-checkoff?state=awaiting_verify&profile_id=${plan.id}`,
    });
    now += 60_000;
    const second = await app.inject({
      method: "GET",
      url: `/printer-checkoff?state=awaiting_verify&profile_id=${plan.id}`,
    });
    dateNow.mockRestore();

    expect(first.json().links[0]).toMatchObject({ id: link.id, units: [] });
    expect(second.json().links[0]).toMatchObject({ id: link.id, units: [] });
    expect(getProfilePartRows).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("repairs an accepted Object name and verifies the same coordinate", async () => {
    const { app, repo, plan, bracket, acceptedPart } = await setup();
    const link = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [],
      unlabeled_names: [acceptedPart.units[0]!.objectName],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "bracket.bgcode",
    });

    const awaiting = await app.inject({
      method: "GET",
      url: `/printer-checkoff?state=awaiting_verify&profile_id=${plan.id}`,
    });
    expect(awaiting.json().links[0].units).toEqual([
      { part_id: bracket.id, unit_index: 0 },
    ]);

    const verify = await app.inject({
      method: "POST",
      url: "/printer-checkoff/verify",
      payload: {
        link_id: link.id,
        decisions: [{ part_id: bracket.id, unit_index: 0, result: "confirmed" }],
      },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ units_confirmed: 1 });
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([true]);
  });

  it("persists Progress when the same API receives a valid mapped unit", async () => {
    const { app, repo, plan, bracket } = await setup();
    const link = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [{ part_id: bracket.id, unit_index: 0 }],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "bracket.bgcode",
    });

    const verify = await app.inject({
      method: "POST",
      url: "/printer-checkoff/verify",
      payload: {
        link_id: link.id,
        decisions: [{ part_id: bracket.id, unit_index: 0, result: "confirmed" }],
      },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ units_confirmed: 1 });
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([true]);
  });

  it("does not attribute repeated complete polls for a linked print", async () => {
    const { app, repo, plan, bracket } = await setup();
    let printerState: "PRINTING" | "FINISHED" = "PRINTING";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/status")) {
        return response({
          printer: { state: printerState },
          job: { progress: 100, file: { display_name: "bracket.bgcode" } },
        });
      }
      if (url.includes("/api/v1/job")) {
        return response({
          state: printerState,
          file: { display_name: "bracket.bgcode" },
          refs: { download: "/usb/bracket.bgcode" },
        });
      }
      if (url.includes("/usb/bracket.bgcode")) {
        return new Response('objects_info={"objects":[{"name":"bracket_01"}]}', { status: 206 });
      }
      return response({});
    }));

    const printing = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });
    const link = printing.json().created_links[0];
    expect(link).toMatchObject({
      profile_id: plan.id,
      filename: "bracket.bgcode",
      units: [{ part_id: bracket.id, unit_index: 0 }],
    });

    printerState = "FINISHED";
    const complete = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });
    expect(complete.json()).toMatchObject({
      updates: [{ link_id: link.id, event: "awaiting_verify" }],
      unattributed: [],
    });

    const repeatedComplete = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });
    expect(repeatedComplete.json()).toMatchObject({
      updates: [],
      unattributed: [],
    });

    const verify = await app.inject({
      method: "POST",
      url: "/printer-checkoff/verify",
      payload: {
        link_id: link.id,
        decisions: [{ part_id: bracket.id, unit_index: 0, result: "confirmed" }],
      },
    });
    expect(verify.statusCode).toBe(200);
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([true]);

    const completeAfterVerify = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });
    expect(completeAfterVerify.json()).toMatchObject({
      updates: [],
      unattributed: [],
    });
  });

  it("filters a linked unattributed duplicate on GET without persisting a claim", async () => {
    const { app, repo, plan } = await setup();
    const link = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "bracket.bgcode",
    });
    const stale = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "BRACKET.BGCODE",
      ["bracket_01"],
      [],
    );
    saveUnattributedPrint(repo, stale);
    const setSetting = vi.spyOn(repo, "setSetting");

    const open = await app.inject({
      method: "GET",
      url: "/printer-checkoff/unattributed",
    });

    expect(open.json().prints).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
    const storedPrint = listUnattributedPrints(repo).find((p) => p.id === stale.id);
    expect(storedPrint?.claimed_at).toBeUndefined();
    expect(storedPrint?.claimed_profile_id).toBeUndefined();
    expect(getPrinterCheckoffLink(repo, link.id)?.state).toBe("awaiting_verify");
  });

  it("filters a linked stale unattributed duplicate during reconcile without persisting a claim", async () => {
    const { app, repo, plan, bracket } = await setup();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/status")) {
        return response({
          printer: { state: "FINISHED" },
          job: { progress: 100, file: { display_name: "BRACKET.BGCODE" } },
        });
      }
      if (url.includes("/api/v1/job")) {
        return response({
          state: "FINISHED",
          file: { display_name: "BRACKET.BGCODE" },
          refs: { download: "/usb/BRACKET.BGCODE" },
        });
      }
      if (url.includes("/usb/BRACKET.BGCODE")) {
        return new Response('objects_info={"objects":[{"name":"bracket_01"}]}', { status: 206 });
      }
      return response({});
    }));

    const link = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [{ part_id: bracket.id, unit_index: 0 }],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "bracket.bgcode",
    });

    const stale = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      ["bracket_01"],
      [],
    );
    saveUnattributedPrint(repo, stale);
    const setSetting = vi.spyOn(repo, "setSetting");

    const repeatedComplete = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });
    expect(repeatedComplete.json().unattributed).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
    const storedPrint = listUnattributedPrints(repo).find((p) => p.id === stale.id);
    expect(storedPrint?.claimed_profile_id).toBeUndefined();
    expect(storedPrint?.claimed_at).toBeUndefined();
    expect(getPrinterCheckoffLink(repo, link.id)?.state).toBe("awaiting_verify");
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([false]);
  });

  it("creates an unattributed print for an unlinked external completion", async () => {
    const { app } = await setup();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/status")) {
        return response({
          printer: { state: "FINISHED" },
          job: { file: { display_name: "external.bgcode" } },
        });
      }
      if (url.includes("/api/v1/job")) {
        return response({
          state: "FINISHED",
          file: { display_name: "external.bgcode" },
          refs: { download: "/usb/external.bgcode" },
        });
      }
      if (url.includes("/usb/external.bgcode")) {
        return new Response('objects_info={"objects":[{"name":"external_01"}]}', { status: 206 });
      }
      return response({});
    }));

    const complete = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      updates: [],
      unattributed: [{
        integration_id: "prusa-1",
        filename: "external.bgcode",
      }],
    });
  });

  it("claims an unattributed Required-unit Object name through accepted attribution", async () => {
    const { app, repo, plan, bracket, acceptedPart } = await setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      [acceptedPart.units[0]!.objectName],
      [],
    );
    saveUnattributedPrint(repo, print);

    const claim = await app.inject({
      method: "POST",
      url: `/printer-checkoff/unattributed/${print.id}/claim`,
      payload: { profile_id: plan.id },
    });

    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({
      ok: true,
      link: {
        state: "awaiting_verify",
        units: [{ part_id: bracket.id, unit_index: 0 }],
      },
    });
    expect(listUnattributedPrints(repo).find((row) => row.id === print.id)).toMatchObject({
      claimed_profile_id: plan.id,
    });
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([false]);

    const verify = await app.inject({
      method: "POST",
      url: "/printer-checkoff/verify",
      payload: {
        link_id: claim.json().link.id,
        decisions: [{ part_id: bracket.id, unit_index: 0, result: "confirmed" }],
      },
    });
    expect(verify.statusCode).toBe(200);
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([true]);
    expect(JSON.parse(repo.getSetting("printer.plan_bindings") ?? "[]")).toEqual([
      expect.objectContaining({ integration_id: "prusa-1", profile_id: plan.id }),
    ]);
  });

  it("assigns an uploaded print file to a Build and manually advances it to Checkoff", async () => {
    const { app, repo, plan, bracket, acceptedPart, planRevisionId } = await setup();
    saveFleet(repo, [parsePrinterMachine({
      id: "offline-printer",
      name: "Garage printer",
      model: "Custom",
      bed_width_mm: 250,
      bed_depth_mm: 210,
      max_filament_slots: 1,
      loaded_filaments: [],
    })]);

    const preview = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments/preview",
      payload: {
        profile_id: plan.id,
        printer_id: "offline-printer",
        filename: "bracket.bgcode",
        object_names: [acceptedPart.units[0]!.objectName],
        tracking: "manual",
      },
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json();
    expect(previewBody).toMatchObject({
      // A manual printer has no host to read bytes from, so PrintPartner says
      // so instead of guessing.
      inspected: false,
      suggested_units: [
        { part_id: bracket.id, unit_index: 0, object_name: acceptedPart.units[0]!.objectName },
      ],
      suggestion_basis: "object_names",
      plan_revision_id: planRevisionId,
    });
    expect(previewBody).not.toHaveProperty("classification");
    expect(previewBody).not.toHaveProperty("print_ready");
    // Preview is read-only.
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);

    const assigned = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: plan.id,
        printer_id: "offline-printer",
        filename: "bracket.bgcode",
        object_names: [acceptedPart.units[0]!.objectName],
        tracking: "manual",
        completed: false,
        plan_revision_id: planRevisionId,
        unit_tokens: [`${bracket.id}:0`],
      },
    });

    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      link: {
        profile_id: plan.id,
        printer_id: "offline-printer",
        integration_id: "manual:offline-printer",
        state: "watching",
        units: [{ part_id: bracket.id, unit_index: 0 }],
        plan_revision_id: planRevisionId,
      },
    });

    const completed = await app.inject({
      method: "POST",
      url: `/printer-checkoff/${assigned.json().link.id}/manual-complete`,
      payload: {},
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      link: { state: "awaiting_verify", host_outcome: "success", last_progress: 100 },
    });
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([false]);
  });

  it("binds only the units the operator confirmed, never a filename match", async () => {
    const { app, repo, plan, bracket, planRevisionId } = await setup();
    saveFleet(repo, [parsePrinterMachine({
      id: "offline-printer",
      name: "Garage printer",
      model: "Custom",
      bed_width_mm: 250,
      bed_depth_mm: 210,
      max_filament_slots: 1,
      loaded_filaments: [],
    })]);
    const assignment = {
      profile_id: plan.id,
      printer_id: "offline-printer",
      // The Part filename, not a Required-unit Object name.
      filename: "bracket.bgcode",
      tracking: "manual",
      plan_revision_id: planRevisionId,
    };

    const preview = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments/preview",
      payload: assignment,
    });
    expect(preview.json()).toMatchObject({
      suggested_units: [{ part_id: bracket.id, unit_index: 0 }],
      suggestion_basis: "filename",
    });

    const unconfirmed = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: { ...assignment, unit_tokens: [] },
    });
    expect(unconfirmed.statusCode).toBe(200);
    expect(unconfirmed.json().link.units).toEqual([]);

    const missingTokens = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: { ...assignment, filename: "bracket-2.bgcode" },
    });
    expect(missingTokens.statusCode).toBe(400);
    expect(missingTokens.json().detail).toContain("unit_tokens");

    const malformed = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: { ...assignment, filename: "bracket-3.bgcode", unit_tokens: ["not-a-token"] },
    });
    expect(malformed.statusCode).toBe(400);

    const confirmed = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        ...assignment,
        filename: "bracket-4.bgcode",
        unit_tokens: [`${bracket.id}:0`],
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().link.units).toEqual([
      expect.objectContaining({ part_id: bracket.id, unit_index: 0 }),
    ]);
    // A confirmed unit that is not an incomplete Required unit is refused.
    const unknownUnit = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        ...assignment,
        filename: "bracket-5.bgcode",
        unit_tokens: [`${bracket.id}:99`],
      },
    });
    expect(unknownUnit.statusCode).toBe(409);
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([false]);
  });

  it("refuses an assignment carrying a superseded Accepted Plan revision", async () => {
    const { app, repo, plan, bracket, planRevisionId } = await setup();
    saveFleet(repo, [parsePrinterMachine({
      id: "offline-printer",
      name: "Garage printer",
      model: "Custom",
      bed_width_mm: 250,
      bed_depth_mm: 210,
      max_filament_slots: 1,
      loaded_filaments: [],
    })]);

    const stale = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: plan.id,
        printer_id: "offline-printer",
        filename: "bracket.bgcode",
        tracking: "manual",
        plan_revision_id: planRevisionId + 1,
        unit_tokens: [`${bracket.id}:0`],
      },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().detail).toContain("Accepted Plan moved on");
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);

    const missingRevision = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: plan.id,
        printer_id: "offline-printer",
        filename: "bracket.bgcode",
        tracking: "manual",
        unit_tokens: [`${bracket.id}:0`],
      },
    });
    expect(missingRevision.statusCode).toBe(400);
    expect(missingRevision.json().detail).toContain("plan_revision_id");
  });

  it("refuses a 3MF with no source, pointing the operator at the upload", async () => {
    const { app, repo, plan, bracket, planRevisionId } = await setup();
    saveFleet(repo, [parsePrinterMachine({
      id: "sd-card-printer",
      name: "SD card printer",
      model: "Custom",
      bed_width_mm: 250,
      bed_depth_mm: 210,
      max_filament_slots: 1,
      loaded_filaments: [],
    })]);

    const assigned = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: plan.id,
        printer_id: "sd-card-printer",
        filename: "finished.gcode.3mf",
        tracking: "manual",
        completed: true,
        plan_revision_id: planRevisionId,
        unit_tokens: [`${bracket.id}:0`],
        // A client may send whatever it likes; the server never takes its word.
        classification: { format: "3mf", kind: "toolpath_package" },
        sliced_3mf_confirmed: true,
      },
    });

    expect(assigned.statusCode).toBe(409);
    expect(assigned.json().detail).toContain("has to read a 3MF");
    expect(assigned.json().detail).toContain("upload the file");
    expect(assigned.json().detail).not.toContain("printer's storage");
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);
  });

  it("previews a steadily progressing remote file beyond 30 seconds without recording a print", async () => {
    const { app, repo, plan } = await setup();
    saveFleet(repo, [parsePrinterMachine({
      id: "core-one",
      name: "Core One",
      model: "Custom",
      bed_width_mm: 250,
      bed_depth_mm: 210,
      max_filament_slots: 1,
      loaded_filaments: [],
      integration_id: "prusa-1",
    })]);
    const before = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    const bytes = bgcode([{ payload: 40 }]);
    const cancel = vi.fn();
    let receivedChunks = 0;
    let elapsedMs = 0;
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => startedAt + elapsedMs);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/status")) return response({ printer: { state: "IDLE" } });
      if (url.endsWith("/api/v1/storage")) {
        return response({ storage_list: [{ path: "usb", available: true }] });
      }
      if (url.endsWith("/api/v1/files/usb/")) {
        return response({
          children: [{ name: "bracket.bgcode", type: "PRINT_FILE", size: bytes.byteLength }],
        });
      }
      if (url.endsWith("/api/v1/files/usb/bracket.bgcode")) {
        return response({ refs: { download: "/api/v1/files/usb/bracket.bgcode/raw" } });
      }
      if (url.endsWith("/raw")) {
        let offset = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            elapsedMs += 10_000;
            receivedChunks += 1;
            controller.enqueue(bytes.subarray(offset, offset + 10));
            offset += 10;
            if (offset >= bytes.byteLength) controller.close();
          },
          cancel,
        }, { highWaterMark: 0 }));
      }
      throw new Error(`unexpected host call ${url}`);
    }));

    try {
      const preview = await app.inject({
        method: "POST",
        url: "/printer-checkoff/file-assignments/preview",
        payload: {
          profile_id: plan.id,
          printer_id: "core-one",
          filename: "bracket.bgcode",
          remote_path: "bracket.bgcode",
          object_names: ["bracket.stl"],
        },
      });

      expect(preview.statusCode, JSON.stringify(preview.json())).toBe(200);
      expect(preview.json()).toMatchObject({
        inspected: true,
        classification: { format: "bgcode" },
        print_ready: true,
      });
      expect(receivedChunks).toBe(6);
      expect(elapsedMs).toBe(60_000);
      expect(cancel).not.toHaveBeenCalled();
      expect(loadPrinterCheckoffLinks(repo)).toEqual([]);
      expect(repo.readAcceptedPlanOperationalSnapshot(plan.id)).toEqual(before);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["declared", "streamed"])("cancels a %s oversized remote file without recording a print", async (sizeMode) => {
    const { app, repo, plan } = await setup();
    saveFleet(repo, [parsePrinterMachine({
      id: "core-one", name: "Core One", model: "Custom",
      bed_width_mm: 250, bed_depth_mm: 210, max_filament_slots: 1,
      loaded_filaments: [], integration_id: "prusa-1",
    })]);
    const before = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const cancel = vi.fn();
    let deliveredBytes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/status")) return response({ printer: { state: "IDLE" } });
      if (url.endsWith("/api/v1/storage")) {
        return response({ storage_list: [{ path: "usb", available: true }] });
      }
      if (url.endsWith("/api/v1/files/usb/")) {
        return response({ children: [{ name: "large.bgcode", type: "PRINT_FILE" }] });
      }
      if (url.endsWith("/api/v1/files/usb/large.bgcode")) {
        return response({ refs: { download: "/api/v1/files/usb/large.bgcode/raw" } });
      }
      if (url.endsWith("/raw")) {
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            deliveredBytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel,
        }, { highWaterMark: 0 }), {
          headers: sizeMode === "declared"
            ? { "content-length": String(MAX_CLASSIFIABLE_BYTES + 1) }
            : {},
        });
      }
      throw new Error(`unexpected host call ${url}`);
    }));

    const preview = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments/preview",
      payload: {
        profile_id: plan.id,
        printer_id: "core-one",
        filename: "large.bgcode",
        remote_path: "large.bgcode",
      },
    });

    expect(preview.statusCode).toBe(409);
    expect(preview.json().detail).toBe("That print file is too large to inspect");
    expect(cancel).toHaveBeenCalledOnce();
    expect(deliveredBytes).toBeLessThanOrEqual(MAX_CLASSIFIABLE_BYTES + chunk.byteLength);
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);
    expect(repo.readAcceptedPlanOperationalSnapshot(plan.id)).toEqual(before);
  });

  it.each(["http", "timeout", "transport"])("handles terminal %s inspection failure without recording a print", async (failureKind) => {
    const { app, repo, plan } = await setup();
    saveFleet(repo, [parsePrinterMachine({
      id: "core-one", name: "Core One", model: "Custom",
      bed_width_mm: 250, bed_depth_mm: 210, max_filament_slots: 1,
      loaded_filaments: [], integration_id: "prusa-1",
    })]);
    const files = getIntegrationAdapter("prusalink")?.files;
    if (!files) throw new Error("Prusa file access is missing");
    const before = repo.readAcceptedPlanOperationalSnapshot(plan.id);
    const cancel = vi.fn();
    const browse = vi.spyOn(files, "browse").mockResolvedValue({ path: "", entries: [] });
    const open = vi.spyOn(files, "open").mockImplementation(async () => {
      if (failureKind === "http") {
        return new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 });
      }
      const error = new Error("Private upstream error text");
      error.name = failureKind === "timeout" ? "TimeoutError" : "Error";
      throw error;
    });

    try {
      const preview = await app.inject({
        method: "POST",
        url: "/printer-checkoff/file-assignments/preview",
        payload: {
          profile_id: plan.id,
          printer_id: "core-one",
          filename: "bracket.bgcode",
          remote_path: "bracket.bgcode",
        },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ inspected: false });
      expect(preview.body).not.toContain("Private upstream error text");
      if (failureKind === "http") expect(cancel).toHaveBeenCalledOnce();
      expect(loadPrinterCheckoffLinks(repo)).toEqual([]);
      expect(repo.readAcceptedPlanOperationalSnapshot(plan.id)).toEqual(before);
    } finally {
      browse.mockRestore();
      open.mockRestore();
    }
  });

  it("refuses a slicer-project 3MF read off a real host, whatever the client claims", async () => {
    const { app, repo, plan, bracket, planRevisionId } = await setup();
    saveFleet(repo, [parsePrinterMachine({
      id: "core-one",
      name: "Core One",
      model: "Custom",
      bed_width_mm: 250,
      bed_depth_mm: 210,
      max_filament_slots: 1,
      loaded_filaments: [],
      integration_id: "prusa-1",
    })]);

    const project = slicerProjectThreeMf();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        // PrusaLink's Digest handshake probes status before every request.
        if (url.endsWith("/api/v1/status")) return response({ printer: { state: "IDLE" } });
        if (url.endsWith("/api/v1/storage")) {
          return response({ storage_list: [{ path: "usb", available: true }] });
        }
        if (url.endsWith("/api/v1/files/usb/")) {
          return response({
            children: [{ name: "project.3mf", type: "PRINT_FILE", size: project.byteLength }],
          });
        }
        if (url.endsWith("/api/v1/files/usb/project.3mf")) {
          return response({ refs: { download: "/api/v1/files/usb/project.3mf/raw" } });
        }
        if (url.endsWith("/raw")) {
          return new Response(project, { status: 200 });
        }
        throw new Error(`unexpected host call ${url}`);
      }),
    );

    const preview = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments/preview",
      payload: {
        profile_id: plan.id,
        printer_id: "core-one",
        filename: "project.3mf",
        remote_path: "project.3mf",
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      inspected: true,
      classification: { format: "3mf", kind: "slicer_project" },
      print_ready: false,
    });

    const assigned = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: plan.id,
        printer_id: "core-one",
        filename: "project.3mf",
        remote_path: "project.3mf",
        plan_revision_id: planRevisionId,
        unit_tokens: [`${bracket.id}:0`],
        // The operator's old checkbox and a forged classification both change
        // nothing: the answer comes from the bytes.
        sliced_3mf_confirmed: true,
        classification: { format: "3mf", kind: "toolpath_package" },
      },
    });
    expect(assigned.statusCode).toBe(409);
    expect(assigned.json().detail).toContain("needs slicing");
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);

    // The same host serving a real toolpath package does assign, and the link
    // keeps a durable identity including the hash of the bytes read.
    const sliced = slicedThreeMf();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/status")) return response({ printer: { state: "IDLE" } });
        if (url.endsWith("/api/v1/storage")) {
          return response({ storage_list: [{ path: "usb", available: true }] });
        }
        if (url.endsWith("/api/v1/files/usb/")) {
          return response({
            children: [
              {
                name: "sliced.3mf",
                type: "PRINT_FILE",
                size: sliced.byteLength,
                m_timestamp: 1_780_000_000,
              },
            ],
          });
        }
        if (url.endsWith("/api/v1/files/usb/sliced.3mf")) {
          return response({ refs: { download: "/api/v1/files/usb/sliced.3mf/raw" } });
        }
        if (url.endsWith("/raw")) return new Response(sliced, { status: 200 });
        throw new Error(`unexpected host call ${url}`);
      }),
    );

    const slicedAssigned = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: plan.id,
        printer_id: "core-one",
        filename: "sliced.3mf",
        remote_path: "sliced.3mf",
        plan_revision_id: planRevisionId,
        unit_tokens: [`${bracket.id}:0`],
      },
    });
    expect(slicedAssigned.statusCode).toBe(200);
    expect(slicedAssigned.json()).toMatchObject({
      link: {
        classification: { format: "3mf", kind: "toolpath_package" },
        plan_revision_id: planRevisionId,
        remote_identity: {
          size_bytes: sliced.byteLength,
          modified_at: new Date(1_780_000_000_000).toISOString(),
          sha256: createHash("sha256").update(sliced).digest("hex"),
        },
      },
    });
  });

  it("refuses bytes it could not read, even for a print that already happened", async () => {
    const { app, repo, plan, bracket, planRevisionId } = await setup();
    saveFleet(repo, [parsePrinterMachine({
      id: "core-one",
      name: "Core One",
      model: "Custom",
      bed_width_mm: 250,
      bed_depth_mm: 210,
      max_filament_slots: 1,
      loaded_filaments: [],
      integration_id: "prusa-1",
    })]);

    const bomb = hostileZip([{ name: "3D/3dmodel.model", uncompressedSize: 0xffff_ffff }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/status")) return response({ printer: { state: "IDLE" } });
        if (url.endsWith("/api/v1/storage")) {
          return response({ storage_list: [{ path: "usb", available: true }] });
        }
        if (url.endsWith("/api/v1/files/usb/")) {
          return response({
            children: [{ name: "bomb.3mf", type: "PRINT_FILE", size: bomb.byteLength }],
          });
        }
        if (url.endsWith("/api/v1/files/usb/bomb.3mf")) {
          return response({ refs: { download: "/api/v1/files/usb/bomb.3mf/raw" } });
        }
        if (url.endsWith("/raw")) return new Response(bomb, { status: 200 });
        throw new Error(`unexpected host call ${url}`);
      }),
    );

    const assigned = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: plan.id,
        printer_id: "core-one",
        filename: "bomb.3mf",
        remote_path: "bomb.3mf",
        // Saying the print is finished lifts print-readiness, and nothing else.
        // A file PrintPartner could not read is a different refusal: there is
        // nothing to attribute the print to.
        completed: true,
        plan_revision_id: planRevisionId,
        unit_tokens: [`${bracket.id}:0`],
      },
    });

    expect(assigned.statusCode).toBe(409);
    expect(assigned.json().detail).toContain("too large to inspect safely");
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);
  });

  it("notices on its own that a linked provider file changed", async () => {
    const { repo, plan, bracket, planRevisionId } = await setup();
    const identity = { size_bytes: 4096, modified_at: "2026-08-01T00:00:00.000Z" };
    const created = repo.materializeAcceptedPrinterLink({
      kind: "create",
      profileId: plan.id,
      expectedPlanRevisionId: planRevisionId,
      objectNames: [],
      confirmedUnits: [{ part_id: bracket.id, unit_index: 0 }],
      link: {
        integrationId: "prusa-1",
        printerId: "core-one",
        hostName: "Core One",
        filename: "bracket.bgcode",
        remotePath: "usb/plates/bracket.bgcode",
        remoteIdentity: identity,
        classification: { format: "bgcode" },
        started: false,
      },
    });
    if (created.kind !== "created") throw new Error(`unexpected outcome ${created.kind}`);

    const browsed: string[] = [];
    const hostFiles = (entries: PrinterStorageEntry[]): PrinterFileAccess => ({
      browse: async (_config, path) => {
        browsed.push(path);
        return { path, entries };
      },
      open: async () => new Response(new Uint8Array(0)),
    });
    const observe = (files: PrinterFileAccess) =>
      observePrinterCheckoffFileDrift({
        repo,
        integrationId: "prusa-1",
        files,
        config: { base_url: "http://127.0.0.1" },
      });

    const unchanged: PrinterStorageEntry[] = [
      { kind: "file", path: "usb/plates/bracket.bgcode", name: "bracket.bgcode", ...identity },
    ];
    await observe(hostFiles(unchanged));
    // One browse of the containing directory, not one per link.
    expect(browsed).toEqual(["usb/plates"]);
    expect(getPrinterCheckoffLink(repo, created.link.id)?.remote_drift).toBeUndefined();

    await observe(
      hostFiles([
        {
          kind: "file",
          path: "usb/plates/bracket.bgcode",
          name: "bracket.bgcode",
          size_bytes: 9001,
          modified_at: identity.modified_at,
        },
      ]),
    );
    expect(getPrinterCheckoffLink(repo, created.link.id)?.remote_drift).toMatchObject({
      reason: "size",
    });

    await observe(hostFiles([]));
    expect(getPrinterCheckoffLink(repo, created.link.id)?.remote_drift).toMatchObject({
      reason: "missing",
    });

    // A host that will not answer has not changed anybody's artifact.
    await observe({
      browse: async () => {
        throw new Error("host unreachable");
      },
      open: async () => new Response(new Uint8Array(0)),
    });
    expect(getPrinterCheckoffLink(repo, created.link.id)?.remote_drift).toMatchObject({
      reason: "missing",
    });

    await observe(hostFiles(unchanged));
    expect(getPrinterCheckoffLink(repo, created.link.id)?.remote_drift).toBeUndefined();
  });

  it("claims only selected unattributed plate files", async () => {
    const { app, repo, plan, bracket, acceptedPart } = await setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "mixed.bgcode",
      [acceptedPart.units[0]!.objectName, "unknown.stl"],
      [],
    );
    saveUnattributedPrint(repo, print);

    const claim = await app.inject({
      method: "POST",
      url: `/printer-checkoff/unattributed/${print.id}/claim`,
      payload: {
        profile_id: plan.id,
        selected_stl_basenames: [acceptedPart.units[0]!.objectName.toLowerCase()],
      },
    });

    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({
      ok: true,
      link: {
        state: "awaiting_verify",
        units: [{ part_id: bracket.id, unit_index: 0 }],
      },
    });
    expect(claim.json().link).not.toHaveProperty("unlabeled_names");
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([false]);
  });

  it.each([
    [{ kind: "empty" } as const, "Accepted Plan has no Required units"],
    [
      { kind: "accepted_state_unavailable", reason: "compatibility_dirty" } as const,
      "Accepted Plan requires compatibility repair",
    ],
    [
      { kind: "accepted_state_unavailable", reason: "uninitialized" } as const,
      "Accepted Plan operational state is not initialized",
    ],
    [
      { kind: "no_match" } as const,
      "That print file does not map to an incomplete Required unit in this Build",
    ],
    [{ kind: "already_linked" } as const, "That print file is already assigned"],
    [{ kind: "print_changed" } as const, "Print changed or was already claimed"],
    [
      { kind: "stale_plan_revision" } as const,
      "The Accepted Plan moved on; reload the Build and choose the file again",
    ],
    [{ kind: "link_changed" } as const, "Tracked print changed; reload and retry"],
  ])("returns a stable conflict for claim outcome %#", async (outcome, detail) => {
    const { app, repo, plan } = await setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      ["bracket.stl"],
      [],
    );
    saveUnattributedPrint(repo, print);
    vi.spyOn(repo, "materializeAcceptedPrinterLink").mockReturnValue(outcome);

    const claim = await app.inject({
      method: "POST",
      url: `/printer-checkoff/unattributed/${print.id}/claim`,
      payload: { profile_id: plan.id },
    });

    expect(claim.statusCode).toBe(409);
    expect(claim.json()).toMatchObject({ detail });
  });

  it("returns 503 when atomic claims are unavailable", async () => {
    const { app, repo, plan } = await setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      ["bracket.stl"],
      [],
    );
    saveUnattributedPrint(repo, print);
    vi.spyOn(repo, "materializeAcceptedPrinterLink").mockReturnValue({
      kind: "transaction_unavailable",
    });

    const claim = await app.inject({
      method: "POST",
      url: `/printer-checkoff/unattributed/${print.id}/claim`,
      payload: { profile_id: plan.id },
    });

    expect(claim.statusCode).toBe(503);
    expect(claim.json()).toMatchObject({ detail: "Accepted Plan update is unavailable" });
  });

  it.each(["unexpected", "integrity"] as const)(
    "redacts %s claim failures from the response and logs",
    async (failureKind) => {
    const { app, repo, plan } = await setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "bracket.bgcode",
      ["bracket.stl"],
      [],
    );
    saveUnattributedPrint(repo, print);
    const sentinel =
      `private /tmp/claim-path ppu_0123456789abcdef0123456789abcdef ${failureKind}`;
    vi.spyOn(repo, "materializeAcceptedPrinterLink").mockImplementation(() => {
      if (failureKind === "integrity") {
        throw new AcceptedPlanOperationalIntegrityError("required_unit_map", sentinel);
      }
      throw new Error(sentinel);
    });
    const capturedErrors: unknown[][] = [];
    app.addHook("onRequest", (request, _reply, done) => {
      request.log.error = (...args: unknown[]) => capturedErrors.push(args);
      done();
    });

    const claim = await app.inject({
      method: "POST",
      url: `/printer-checkoff/unattributed/${print.id}/claim`,
      payload: { profile_id: plan.id },
    });

    expect(claim.statusCode).toBe(500);
    expect(claim.json()).toMatchObject({ detail: "Internal Server Error" });
    expect(JSON.stringify([claim.json(), capturedErrors])).not.toContain(sentinel);
    expect(capturedErrors).toEqual([
      [
        failureKind === "integrity"
          ? {
              failure: "integrity",
              code: "required_unit_map",
              profileId: plan.id,
              printId: print.id,
            }
          : { failure: "unexpected", profileId: plan.id, printId: print.id },
        "Accepted printer claim failed",
      ],
    ]);
    },
  );

  it("does not claim an unattributed print when no accepted unit matches", async () => {
    const { app, repo, plan } = await setup();
    const print = createUnattributedPrint(
      "prusa-1",
      "core-one",
      "Core One",
      "unknown.bgcode",
      ["unknown-object"],
      [],
    );
    saveUnattributedPrint(repo, print);

    const claim = await app.inject({
      method: "POST",
      url: `/printer-checkoff/unattributed/${print.id}/claim`,
      payload: { profile_id: plan.id },
    });

    expect(claim.statusCode).toBe(409);
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);
    expect(listUnattributedPrints(repo).find((row) => row.id === print.id)).not.toHaveProperty(
      "claimed_at",
    );
  });

  it("does not auto-create a link when accepted attribution is unavailable", async () => {
    const { app, repo } = await setup();
    vi.spyOn(repo, "materializeAcceptedPrinterLink").mockReturnValue({
      kind: "accepted_state_unavailable",
      reason: "compatibility_dirty",
    });
    const setSetting = vi.spyOn(repo, "setSetting");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/status")) {
        return response({
          printer: { state: "PRINTING" },
          job: { progress: 1, file: { display_name: "bracket.bgcode" } },
        });
      }
      if (url.includes("/api/v1/job")) {
        return response({
          state: "PRINTING",
          file: { display_name: "bracket.bgcode" },
          refs: { download: "/usb/bracket.bgcode" },
        });
      }
      if (url.includes("/usb/bracket.bgcode")) {
        return new Response('objects_info={"objects":[{"name":"bracket.stl"}]}', {
          status: 206,
        });
      }
      return response({});
    }));

    const reconcile = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });

    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.json().created_links).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it.each(["unexpected", "integrity"] as const)(
    "preserves reconcile updates and returns 200 after %s auto-attribution failure",
    async (failureKind) => {
    const { app, repo, plan, bracket } = await setup();
    const existing = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "queued-name.bgcode",
      remote_path: "bracket.bgcode",
      units: [{ part_id: bracket.id, unit_index: 0 }],
    })!;
    const sentinel = `private /tmp/auto-path digest-ffffffff ${failureKind}`;
    vi.spyOn(repo, "materializeAcceptedPrinterLink").mockImplementation(() => {
      if (failureKind === "integrity") {
        throw new AcceptedPlanOperationalIntegrityError("required_unit_map", sentinel);
      }
      throw new Error(sentinel);
    });
    const capturedErrors: unknown[][] = [];
    app.addHook("onRequest", (request, _reply, done) => {
      request.log.error = (...args: unknown[]) => capturedErrors.push(args);
      done();
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/status")) {
        return response({
          printer: { state: "PRINTING" },
          job: { progress: 31, file: { display_name: "bracket.bgcode" } },
        });
      }
      if (url.includes("/api/v1/job")) {
        return response({
          state: "PRINTING",
          file: { display_name: "bracket.bgcode" },
          refs: { download: "/usb/bracket.bgcode" },
        });
      }
      if (url.includes("/usb/bracket.bgcode")) {
        return new Response('objects_info={"objects":[{"name":"bracket.stl"}]}', {
          status: 206,
        });
      }
      return response({});
    }));

    const reconcile = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });

    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.json()).toMatchObject({ updates: [], created_links: [] });
    expect(getPrinterCheckoffLink(repo, existing.id)).toMatchObject({
      saw_active: true,
      last_progress: 31,
    });
    expect(JSON.stringify([reconcile.json(), capturedErrors])).not.toContain(sentinel);
    expect(capturedErrors).toEqual([
      [
        failureKind === "integrity"
          ? {
              failure: "integrity",
              code: "required_unit_map",
              profileId: plan.id,
              integrationId: "prusa-1",
            }
          : { failure: "unexpected", profileId: plan.id, integrationId: "prusa-1" },
        "Accepted printer auto-attribution failed",
      ],
    ]);
    },
  );

  it("preserves reconcile updates when printer Plan bindings are malformed", async () => {
    const { app, repo, plan, bracket } = await setup();
    const existing = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "queued-name.bgcode",
      remote_path: "bracket.bgcode",
      units: [{ part_id: bracket.id, unit_index: 0 }],
    })!;
    const sentinel = "private /tmp/binding-path ppu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    repo.setSetting("printer.plan_bindings", `{${sentinel}`);
    const capturedErrors: unknown[][] = [];
    app.addHook("onRequest", (request, _reply, done) => {
      request.log.error = (...args: unknown[]) => capturedErrors.push(args);
      done();
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/status")) {
        return response({
          printer: { state: "PRINTING" },
          job: { progress: 47, file: { display_name: "bracket.bgcode" } },
        });
      }
      if (url.includes("/api/v1/job")) {
        return response({
          state: "PRINTING",
          file: { display_name: "bracket.bgcode" },
          refs: { download: "/usb/bracket.bgcode" },
        });
      }
      return response({});
    }));

    const reconcile = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });

    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.json()).toMatchObject({ updates: [], created_links: [] });
    expect(getPrinterCheckoffLink(repo, existing.id)).toMatchObject({
      saw_active: true,
      last_progress: 47,
    });
    expect(JSON.stringify([reconcile.json(), capturedErrors])).not.toContain(sentinel);
    expect(capturedErrors).toEqual([
      [
        { failure: "unexpected", integrationId: "prusa-1" },
        "Accepted printer auto-attribution failed",
      ],
    ]);
  });

  it("redacts accepted integrity failures during durable repair", async () => {
    const { app, repo, plan } = await setup();
    const link = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [],
      unlabeled_names: ["bracket.stl"],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "bracket.bgcode",
    });
    vi.spyOn(repo, "materializeAcceptedPrinterLink").mockImplementation(() => {
      throw new AcceptedPlanOperationalIntegrityError(
        "required_unit_map",
        "private-integrity-sentinel",
      );
    });

    const result = await app.inject({
      method: "GET",
      url: `/printer-checkoff?state=awaiting_verify&profile_id=${plan.id}`,
    });

    expect(result.statusCode).toBe(500);
    expect(result.json()).toMatchObject({ detail: "Internal Server Error" });
    expect(result.body).not.toContain("private-integrity-sentinel");
    expect(getPrinterCheckoffLink(repo, link.id)?.units).toEqual([]);
  });

  it("redacts unexpected durable-repair failures from the response and logs", async () => {
    const { app, repo, plan } = await setup();
    const link = createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [],
      unlabeled_names: ["bracket.stl"],
    })!;
    reconcilePrinterCheckoff(repo, "prusa-1", {
      state: "complete",
      filename: "bracket.bgcode",
    });
    const sentinel = "private /tmp/repair-path digest-eeeeeeee";
    vi.spyOn(repo, "materializeAcceptedPrinterLink").mockImplementation(() => {
      throw new Error(sentinel);
    });
    const capturedErrors: unknown[][] = [];
    app.addHook("onRequest", (request, _reply, done) => {
      request.log.error = (...args: unknown[]) => capturedErrors.push(args);
      done();
    });

    const result = await app.inject({
      method: "GET",
      url: `/printer-checkoff?state=awaiting_verify&profile_id=${plan.id}`,
    });

    expect(result.statusCode).toBe(500);
    expect(result.json()).toMatchObject({ detail: "Internal Server Error" });
    expect(JSON.stringify([result.json(), capturedErrors])).not.toContain(sentinel);
    expect(capturedErrors).toEqual([
      [
        { failure: "unexpected", linkId: link.id, profileId: plan.id },
        "Accepted printer link repair failed",
      ],
    ]);
  });

  it("keeps flat and v1 stored-link responses identical", async () => {
    const { app, repo, plan, bracket } = await setup();
    createPrinterCheckoffLink(repo, {
      profile_id: plan.id,
      integration_id: "prusa-1",
      printer_id: "core-one",
      host_name: "Core One",
      filename: "bracket.bgcode",
      units: [{ part_id: bracket.id, unit_index: 0 }],
    });

    const flat = await app.inject({ method: "GET", url: "/printer-checkoff" });
    const v1 = await app.inject({ method: "GET", url: "/api/v1/printer-checkoff" });

    expect(v1.statusCode).toBe(flat.statusCode);
    expect(v1.json()).toEqual(flat.json());
  });
});

describe("uploaded print files", () => {
  const SLICED_GCODE = strToU8("; sliced elsewhere\nG28 ; home\nG1 X10 Y10 E1\n");

  /** A Build whose print was made on a printer PrintPartner cannot reach. */
  async function externalPrinter() {
    const fixture = await setup();
    saveFleet(fixture.repo, [parsePrinterMachine({
      id: "unsupported-printer",
      name: "Ancient Delta",
      model: "Custom",
      bed_width_mm: 250,
      bed_depth_mm: 210,
      max_filament_slots: 1,
      loaded_filaments: [],
    })]);
    return fixture;
  }

  async function uploadPrintFile(input: {
    app: FastifyInstance;
    profileId: number;
    filename: string;
    bytes: Uint8Array;
    objectNames?: string;
  }) {
    return input.app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments/upload",
      ...multipartUpload({
        fields: {
          profile_id: String(input.profileId),
          ...(input.objectNames === undefined ? {} : { object_names: input.objectNames }),
        },
        file: { filename: input.filename, bytes: input.bytes },
      }),
    });
  }

  it.each([
    { what: "ASCII G-code", filename: "elsewhere.gcode", bytes: SLICED_GCODE, format: "gcode" },
    {
      what: "binary G-code",
      filename: "elsewhere.bgcode",
      bytes: bgcode([{ payload: 16 }]),
      format: "bgcode",
    },
    {
      what: "a toolpath 3MF",
      filename: "elsewhere.gcode.3mf",
      bytes: slicedThreeMf(),
      format: "3mf",
    },
  ])("classifies $what off the operator's computer and records its hash", async (fixtureCase) => {
    const { app, repo, plan, bracket, planRevisionId } = await externalPrinter();
    const uploaded = await uploadPrintFile({
      app,
      profileId: plan.id,
      filename: fixtureCase.filename,
      bytes: fixtureCase.bytes,
    });

    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({
      inspected: true,
      print_ready: true,
      next_action: "",
      classification: { format: fixtureCase.format },
      plan_revision_id: planRevisionId,
    });
    const uploadToken = uploaded.json().upload_token;
    expect(typeof uploadToken).toBe("string");

    const assigned = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: plan.id,
        printer_id: "unsupported-printer",
        tracking: "manual",
        completed: true,
        filename: fixtureCase.filename,
        upload_token: uploadToken,
        plan_revision_id: planRevisionId,
        unit_tokens: [`${bracket.id}:0`],
      },
    });

    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      link: {
        state: "awaiting_verify",
        // Nothing on a printer PrintPartner can reach backs this link.
        classification: { format: fixtureCase.format },
        remote_identity: {
          size_bytes: fixtureCase.bytes.byteLength,
          sha256: createHash("sha256").update(fixtureCase.bytes).digest("hex"),
        },
        units: [{ part_id: bracket.id, unit_index: 0 }],
      },
    });
    expect(assigned.json().link.remote_path).toBeUndefined();
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([false]);
  });

  it("refuses an uploaded slicer project that is not being recorded as already made", async () => {
    const fixture = await externalPrinter();
    const project = slicerProjectThreeMf();

    const uploaded = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "project.3mf",
      bytes: project,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({
      inspected: true,
      print_ready: false,
      classification: { format: "3mf", kind: "slicer_project" },
    });
    expect(uploaded.json().next_action).toContain("needs slicing");

    // Nothing says this print happened, so PrintPartner may still be asked to
    // send these bytes to a printer, and no printer can run them. The token
    // survives a refusal, so both attempts argue about the same upload.
    const assign = async (completed: boolean | undefined) =>
      fixture.app.inject({
        method: "POST",
        url: "/printer-checkoff/file-assignments",
        payload: {
          profile_id: fixture.plan.id,
          printer_id: "unsupported-printer",
          tracking: "manual",
          filename: "project.3mf",
          upload_token: uploaded.json().upload_token,
          plan_revision_id: fixture.planRevisionId,
          unit_tokens: [`${fixture.bracket.id}:0`],
          ...(completed === undefined ? {} : { completed }),
        },
      });

    for (const completed of [undefined, false]) {
      const assigned = await assign(completed);
      expect(assigned.statusCode).toBe(409);
      expect(assigned.json().detail).toContain("needs slicing");
    }
    expect(loadPrinterCheckoffLinks(fixture.repo)).toEqual([]);
  });

  it("records an uploaded slicer project as a print that already happened", async () => {
    const fixture = await externalPrinter();
    const project = slicerProjectThreeMf();

    const uploaded = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "project.3mf",
      bytes: project,
      objectNames: "bracket",
    });
    expect(uploaded.json()).toMatchObject({
      print_ready: false,
      classification: { format: "3mf", kind: "slicer_project" },
    });

    const assigned = await fixture.app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: fixture.plan.id,
        printer_id: "unsupported-printer",
        tracking: "manual",
        // The print is finished. The file is what it was made from, so
        // print-readiness has nothing left to gate, and a Bambu or Orca
        // project save is the ordinary thing an operator has on disk.
        completed: true,
        filename: "project.3mf",
        upload_token: uploaded.json().upload_token,
        object_names: ["bracket"],
        plan_revision_id: fixture.planRevisionId,
        unit_tokens: [`${fixture.bracket.id}:0`],
      },
    });

    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      link: {
        state: "awaiting_verify",
        // The record says what the file really is, not what a printer could do
        // with it.
        classification: { format: "3mf", kind: "slicer_project" },
        remote_identity: {
          size_bytes: project.byteLength,
          sha256: createHash("sha256").update(project).digest("hex"),
        },
        units: [{ part_id: fixture.bracket.id, unit_index: 0 }],
      },
    });
    expect(loadPrinterCheckoffLinks(fixture.repo)).toHaveLength(1);
    // The print is on the record; the units still wait for Checkoff.
    expect(acceptedPrintUnits(fixture.repo, fixture.plan.id, fixture.bracket.id)).toEqual([false]);
  });

  it("refuses a request naming both a printer path and an upload", async () => {
    const fixture = await externalPrinter();
    const uploaded = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "elsewhere.gcode",
      bytes: SLICED_GCODE,
    });

    const assigned = await fixture.app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: fixture.plan.id,
        printer_id: "unsupported-printer",
        tracking: "manual",
        filename: "elsewhere.gcode",
        remote_path: "usb/elsewhere.gcode",
        upload_token: uploaded.json().upload_token,
        plan_revision_id: fixture.planRevisionId,
        unit_tokens: [`${fixture.bracket.id}:0`],
      },
    });
    expect(assigned.statusCode).toBe(400);
    expect(assigned.json().detail).toContain("not both");
    expect(loadPrinterCheckoffLinks(fixture.repo)).toEqual([]);
  });

  it("refuses an unknown token rather than recording an unclassified print", async () => {
    const fixture = await externalPrinter();

    const assigned = await fixture.app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: fixture.plan.id,
        printer_id: "unsupported-printer",
        tracking: "manual",
        filename: "elsewhere.gcode",
        upload_token: "9f1c0d3e-0000-4000-8000-000000000000",
        plan_revision_id: fixture.planRevisionId,
        unit_tokens: [`${fixture.bracket.id}:0`],
      },
    });
    expect(assigned.statusCode).toBe(409);
    expect(assigned.json().detail).toContain("upload the print file again");
    expect(loadPrinterCheckoffLinks(fixture.repo)).toEqual([]);
  });

  it("expires a token, and spends it once the print is recorded", async () => {
    const fixture = await externalPrinter();
    const assign = async (uploadToken: string) =>
      fixture.app.inject({
        method: "POST",
        url: "/printer-checkoff/file-assignments",
        payload: {
          profile_id: fixture.plan.id,
          printer_id: "unsupported-printer",
          tracking: "manual",
          filename: "elsewhere.gcode",
          upload_token: uploadToken,
          plan_revision_id: fixture.planRevisionId,
          unit_tokens: [`${fixture.bracket.id}:0`],
        },
      });

    const spent = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "elsewhere.gcode",
      bytes: SLICED_GCODE,
    });
    const spentToken = spent.json().upload_token;
    expect((await assign(spentToken)).statusCode).toBe(200);
    const replayed = await assign(spentToken);
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json().detail).toContain("upload the print file again");

    // A token an operator abandoned is gone once its window closes, whatever
    // the state of the Build it was made for.
    const stale = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "later.gcode",
      bytes: SLICED_GCODE,
    });
    const staleToken = stale.json().upload_token;
    // Only the clock the token is read against moves; faking the event loop
    // would hang the request this test has to make.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60_000);
    try {
      const expired = await assign(staleToken);
      expect(expired.statusCode).toBe(409);
      expect(expired.json().detail).toContain("upload the print file again");
    } finally {
      clock.mockRestore();
    }
  });

  it("refuses a token issued for another Build", async () => {
    const fixture = await externalPrinter();
    const uploaded = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "elsewhere.gcode",
      bytes: SLICED_GCODE,
    });
    const otherPlan = fixture.repo.createProfile("Second Build");
    acceptPlanForTest(fixture.repo, otherPlan.id);

    const assigned = await fixture.app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: otherPlan.id,
        printer_id: "unsupported-printer",
        tracking: "manual",
        filename: "elsewhere.gcode",
        upload_token: uploaded.json().upload_token,
        plan_revision_id: fixture.planRevisionId,
        unit_tokens: [`${fixture.bracket.id}:0`],
      },
    });
    expect(assigned.statusCode).toBe(409);
    expect(assigned.json().detail).toContain("upload the print file again");
    expect(loadPrinterCheckoffLinks(fixture.repo)).toEqual([]);
  });

  it("refuses a zip bomb on the declared sizes, without unpacking it", async () => {
    const fixture = await externalPrinter();
    const bomb = hostileZip([
      { name: "3D/3dmodel.model", uncompressedSize: 0xffff_ffff },
    ]);

    const uploaded = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "bomb.3mf",
      bytes: bomb,
    });
    expect(uploaded.statusCode).toBe(409);
    expect(uploaded.json().detail).toContain("too large to inspect safely");
  });

  it("refuses an upload past the size cap before classifying it", async () => {
    const fixture = await externalPrinter();
    const oversized = new Uint8Array(64 * 1024 * 1024 + 1).fill(0x47);

    const uploaded = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "huge.gcode",
      bytes: oversized,
    });
    expect(uploaded.statusCode).toBe(413);
    expect(uploaded.json().detail).toContain("64 MB");
  });

  it("stops holding uploads past the total budget, and frees it on the next sweep", async () => {
    const fixture = await externalPrinter();
    // Two uploads exactly fill the 128 MB PrintPartner will hold at once. The
    // bytes have to be runnable G-code, or they would be refused before they
    // ever reached the budget.
    const large = new Uint8Array(64 * 1024 * 1024).fill(0x0a);
    large.set(strToU8("G28\nG1 X10 Y10 E1\n"), 0);
    // Step the clock past every window an earlier test opened, so this test
    // measures the budget rather than whatever those tests left behind.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 16 * 60_000);
    try {
      for (const filename of ["first.gcode", "second.gcode"]) {
        const held = await uploadPrintFile({
          app: fixture.app,
          profileId: fixture.plan.id,
          filename,
          bytes: large,
        });
        expect(held.statusCode).toBe(200);
      }

      const overflowing = await uploadPrintFile({
        app: fixture.app,
        profileId: fixture.plan.id,
        filename: "third.gcode",
        bytes: SLICED_GCODE,
      });
      expect(overflowing.statusCode).toBe(503);
      expect(overflowing.json().detail).toContain("as many uploaded print files as it will");

      // Nobody came back for the two big ones, so the next upload past their
      // window sweeps them and the budget is free again.
      clock.mockReturnValue(realNow + 32 * 60_000);
      const afterSweep = await uploadPrintFile({
        app: fixture.app,
        profileId: fixture.plan.id,
        filename: "fourth.gcode",
        bytes: SLICED_GCODE,
      });
      expect(afterSweep.statusCode).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  it("refuses bytes no printer could run, and an upload with no print file", async () => {
    const fixture = await externalPrinter();

    const noise = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "notes.gcode",
      bytes: strToU8("; only comments\n"),
    });
    expect(noise.statusCode).toBe(409);
    expect(noise.json().detail).toContain("not G-code");

    const wrongSuffix = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "model.stl",
      bytes: SLICED_GCODE,
    });
    expect(wrongSuffix.statusCode).toBe(400);
    expect(wrongSuffix.json().detail).toContain(".gcode");

    const missing = await fixture.app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments/upload",
      ...multipartUpload({ fields: { profile_id: String(fixture.plan.id) } }),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().detail).toContain("Attach the print file");
  });

  it("suggests from object labels the browser sends, and from the filename without them", async () => {
    const fixture = await externalPrinter();

    const byFilename = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "bracket.gcode",
      bytes: SLICED_GCODE,
    });
    expect(byFilename.json()).toMatchObject({
      suggestion_basis: "filename",
      suggested_units: [{ part_id: fixture.bracket.id, unit_index: 0 }],
    });

    const byLabels = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "plate-1.gcode",
      bytes: SLICED_GCODE,
      objectNames: JSON.stringify(["bracket.stl_id_0_copy_0"]),
    });
    expect(byLabels.json()).toMatchObject({
      suggestion_basis: "object_names",
      suggested_units: [{ part_id: fixture.bracket.id, unit_index: 0 }],
    });

    // Unreadable labels fall back rather than failing the upload.
    const broken = await uploadPrintFile({
      app: fixture.app,
      profileId: fixture.plan.id,
      filename: "bracket.gcode",
      bytes: SLICED_GCODE,
      objectNames: "not json",
    });
    expect(broken.statusCode).toBe(200);
    expect(broken.json().suggestion_basis).toBe("filename");
  });

  /**
   * A print made on a printer nobody registered. `printer_id` is absent, which
   * is the point: PrintPartner cannot reach the machine that ran the file, so
   * making the operator register it first would be friction for nothing.
   */
  async function assignUnmanagedPrint(input: {
    app: FastifyInstance;
    profileId: number;
    partId: number;
    planRevisionId: number;
    completed: boolean;
  }) {
    const uploaded = await uploadPrintFile({
      app: input.app,
      profileId: input.profileId,
      filename: "elsewhere.gcode",
      bytes: SLICED_GCODE,
    });
    expect(uploaded.statusCode).toBe(200);
    return input.app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: input.profileId,
        tracking: "manual",
        completed: input.completed,
        filename: "elsewhere.gcode",
        upload_token: uploaded.json().upload_token,
        plan_revision_id: input.planRevisionId,
        unit_tokens: [`${input.partId}:0`],
      },
    });
  }

  it("records a print against no registered printer at all", async () => {
    const { app, repo, plan, bracket, planRevisionId } = await setup();
    // An empty fleet is the case that used to be refused outright.
    expect(loadFleet(repo)).toEqual([]);

    const previewed = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments/preview",
      payload: {
        profile_id: plan.id,
        filename: "elsewhere.gcode",
        object_names: ["bracket.stl_id_0_copy_0"],
      },
    });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json()).toMatchObject({
      suggestion_basis: "object_names",
      suggested_units: [{ part_id: bracket.id, unit_index: 0 }],
    });

    const assigned = await assignUnmanagedPrint({
      app,
      profileId: plan.id,
      partId: bracket.id,
      planRevisionId,
      completed: true,
    });
    expect(assigned.statusCode).toBe(200);
    const link = assigned.json().link;
    expect(link).toMatchObject({
      printer_id: UNMANAGED_PRINTER_ID,
      integration_id: "manual:unmanaged",
      host_name: UNMANAGED_PRINTER_NAME,
      state: "awaiting_verify",
      units: [{ part_id: bracket.id, unit_index: 0 }],
    });
    // Reads as manual, which is what keeps every host-only path off it.
    expect(isManualIntegrationId(link.integration_id, link.printer_id)).toBe(true);
    // Verify-first survives: importing the file records the print, it does not
    // tick the units.
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([false]);
  });

  it("finishes a print on an unmanaged printer through manual-complete", async () => {
    const { app, repo, plan, bracket, planRevisionId } = await setup();
    const assigned = await assignUnmanagedPrint({
      app,
      profileId: plan.id,
      partId: bracket.id,
      planRevisionId,
      completed: false,
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().link.state).toBe("watching");

    const completed = await app.inject({
      method: "POST",
      url: `/printer-checkoff/${assigned.json().link.id}/manual-complete`,
      payload: {},
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().link).toMatchObject({
      state: "awaiting_verify",
      host_outcome: "success",
    });
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([false]);
  });

  it.each([
    {
      what: "host tracking for a printer PrintPartner does not manage",
      overrides: { tracking: "host" },
      status: 400,
      detail: "cannot watch a printer it does not manage",
    },
    {
      what: "a printer that is not in the fleet",
      overrides: { printer_id: "never-registered", tracking: "manual" },
      status: 404,
      detail: "Printer not found",
    },
    {
      what: "a file held on a printer with no printer named",
      overrides: { tracking: "manual", remote_path: "usb/elsewhere.gcode" },
      status: 400,
      detail: "file held on a printer needs the printer it sits on",
    },
  ])("refuses $what", async (refusal) => {
    const { app, repo, plan, bracket, planRevisionId } = await setup();

    const assigned = await app.inject({
      method: "POST",
      url: "/printer-checkoff/file-assignments",
      payload: {
        profile_id: plan.id,
        completed: true,
        filename: "elsewhere.gcode",
        plan_revision_id: planRevisionId,
        unit_tokens: [`${bracket.id}:0`],
        ...refusal.overrides,
      },
    });
    expect(assigned.statusCode).toBe(refusal.status);
    expect(assigned.json().detail).toContain(refusal.detail);
    expect(loadPrinterCheckoffLinks(repo)).toEqual([]);
  });

  it("keeps reconcile away from a print PrintPartner does not manage", async () => {
    const { app, repo, plan, bracket, planRevisionId } = await setup();
    // A registered host reporting a finished file of the same name is the only
    // way reconcile could plausibly reach an unmanaged link.
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/status")) {
        return response({
          printer: { state: "FINISHED" },
          job: { progress: 100, file: { display_name: "ELSEWHERE.GCODE" } },
        });
      }
      if (url.includes("/api/v1/job")) {
        return response({ state: "FINISHED", file: { display_name: "ELSEWHERE.GCODE" } });
      }
      return response({});
    }));

    const assigned = await assignUnmanagedPrint({
      app,
      profileId: plan.id,
      partId: bracket.id,
      planRevisionId,
      completed: false,
    });
    expect(assigned.statusCode).toBe(200);
    const linkId = assigned.json().link.id;
    expect(getPrinterCheckoffLink(repo, linkId)?.state).toBe("watching");

    // The unmanaged integration id is not a registered integration, so the
    // route that drives reconcile cannot even name it.
    const named = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "manual:unmanaged" },
    });
    expect(named.statusCode).toBe(404);
    expect(getPrinterCheckoffLink(repo, linkId)?.state).toBe("watching");

    const hostPoll = await app.inject({
      method: "POST",
      url: "/printer-checkoff/reconcile",
      payload: { integration_id: "prusa-1" },
    });
    expect(hostPoll.statusCode).toBe(200);
    expect(hostPoll.json().updates).toEqual([]);
    expect(hostPoll.json().created_links).toEqual([]);
    // The host's own finish became its own unattributed print rather than
    // being matched onto the unmanaged link.
    expect(hostPoll.json().unattributed).toMatchObject([{ integration_id: "prusa-1" }]);
    expect(getPrinterCheckoffLink(repo, linkId)).toMatchObject({ state: "watching" });
    expect(getPrinterCheckoffLink(repo, linkId)?.completed_at).toBeUndefined();
    // Nothing on a host backs this link, so file drift has nothing to observe.
    expect(getPrinterCheckoffLink(repo, linkId)?.remote_path).toBeUndefined();
    expect(acceptedPrintUnits(repo, plan.id, bracket.id)).toEqual([false]);
  });
});
