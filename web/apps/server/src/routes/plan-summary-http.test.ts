import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import type {
  AcceptedProfileProgress,
  AcceptedProfileSummary,
  ProfileHeader,
} from "../db/repository.js";

const directories: string[] = [];

afterEach(() => {
  delete process.env.PRINT_PARTNER_API_KEY;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pp-plan-summary-http-"));
  directories.push(directory);
  process.env.PRINT_PARTNER_DATA_DIR = directory;
  delete process.env.PRINT_PARTNER_API_KEY;
  const ports = createSelfHostPorts(directory);
  await ports.db.connect();
  const app = await buildApp(loadConfig(), ports);
  return { app, ports };
}

function summary(
  header: ProfileHeader,
  progress: AcceptedProfileProgress,
): AcceptedProfileSummary {
  return { header, progress };
}

function withoutIdentity(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, id: 0, name: "normalized", last_used_at: null };
}

describe("Plan summary HTTP contracts", () => {
  it("keeps all seven flat and v2 summary response patterns on the accepted contract", async () => {
    const { app, ports } = await fixture();
    try {
      const template = ports.repository.createProfile("Template");

      const flatList = await app.inject({ method: "GET", url: "/plans" });
      const v2List = await app.inject({ method: "GET", url: "/api/v2/plans" });
      expect(v2List.json()).toEqual(flatList.json());

      const flatDetail = await app.inject({ method: "GET", url: `/plans/${template.id}` });
      const v2Detail = await app.inject({ method: "GET", url: `/api/v2/plans/${template.id}` });
      expect(v2Detail.json()).toEqual(flatDetail.json());
      expect(flatDetail.json()).toEqual({
        ...ports.repository.getProfileHeader(template.id),
        accepted_progress: { kind: "empty" },
      });

      const flatCreate = await app.inject({
        method: "POST",
        url: "/plans",
        payload: { name: "Created" },
      });
      const v2Create = await app.inject({
        method: "POST",
        url: "/api/v2/plans",
        payload: { name: "Created v2" },
      });
      expect(withoutIdentity(v2Create.json())).toEqual(withoutIdentity(flatCreate.json()));
      for (const response of [flatCreate, v2Create]) {
        const body = response.json();
        expect(body).toEqual({
          ...ports.repository.getProfileHeader(body.id),
          accepted_progress: { kind: "empty" },
          layers: [],
        });
      }

      const patch = { name: "Renamed", special_request: "Handle carefully" };
      const flatPatch = await app.inject({
        method: "PATCH",
        url: `/plans/${template.id}`,
        payload: patch,
      });
      const v2Patch = await app.inject({
        method: "PATCH",
        url: `/api/v2/plans/${template.id}`,
        payload: patch,
      });
      expect(v2Patch.json()).toEqual(flatPatch.json());
      expect(flatPatch.json()).toEqual({
        ...ports.repository.getProfileHeader(template.id),
        accepted_progress: { kind: "empty" },
      });

      const fixedTouch = {
        ...ports.repository.getProfileHeader(template.id)!,
        last_used_at: "2026-08-21T12:00:00.000Z",
      };
      ports.repository.touchProfileLastUsed = () => fixedTouch;
      const flatTouch = await app.inject({
        method: "POST",
        url: `/plans/${template.id}/touch`,
      });
      const v2Touch = await app.inject({
        method: "POST",
        url: `/api/v2/plans/${template.id}/touch`,
      });
      expect(v2Touch.json()).toEqual(flatTouch.json());
      expect(flatTouch.json()).toEqual({
        ...fixedTouch,
        accepted_progress: { kind: "empty" },
      });

      const archivedHeader = {
        ...ports.repository.getProfileHeader(template.id)!,
        archived_at: "2026-08-21T12:01:00.000Z",
      };
      ports.repository.readAcceptedProfileSummary = () => ({
        kind: "found",
        summary: summary(archivedHeader, { kind: "empty" }),
      });
      const flatArchive = await app.inject({
        method: "POST",
        url: `/plans/${template.id}/archive`,
      });
      const v2Archive = await app.inject({
        method: "POST",
        url: `/api/v2/plans/${template.id}/archive`,
      });
      expect(v2Archive.json()).toEqual(flatArchive.json());
      expect(flatArchive.json()).toEqual({
        ...archivedHeader,
        accepted_progress: { kind: "empty" },
      });

      const source = ports.repository.createProfile("Duplicate source");
      const flatDuplicate = await app.inject({
        method: "POST",
        url: `/plans/${source.id}/duplicate`,
        payload: { name: "Copy" },
      });
      const v2Duplicate = await app.inject({
        method: "POST",
        url: `/api/v2/plans/${source.id}/duplicate`,
        payload: { name: "Copy v2" },
      });
      expect(withoutIdentity(v2Duplicate.json())).toEqual(
        withoutIdentity(flatDuplicate.json()),
      );
      for (const response of [flatDuplicate, v2Duplicate]) {
        const body = response.json();
        expect(body).toEqual({
          ...ports.repository.getProfileHeader(body.id),
          accepted_progress: { kind: "empty" },
          layers: [],
        });
      }
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("maps v1 unavailable states exactly and gives integrity precedence for lists", async () => {
    const { app, ports } = await fixture();
    try {
      const first = ports.repository.createProfile("First");
      const second = ports.repository.createProfile("Second");
      const firstHeader = ports.repository.getProfileHeader(first.id)!;
      const secondHeader = ports.repository.getProfileHeader(second.id)!;

      for (const progress of [
        { kind: "unavailable", reason: "compatibility_dirty" } as const,
        { kind: "unavailable", reason: "uninitialized" } as const,
        { kind: "concurrent_update" } as const,
      ]) {
        ports.repository.listAcceptedProfileSummaries = () => [summary(firstHeader, progress)];
        const response = await app.inject({ method: "GET", url: "/api/v1/plans" });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          detail: "Accepted Plan progress is unavailable for one or more Plans",
        });
        expect(response.json()).not.toHaveProperty("profiles");
      }

      ports.repository.listAcceptedProfileSummaries = () => [
        summary(firstHeader, { kind: "unavailable", reason: "uninitialized" }),
        summary(secondHeader, { kind: "integrity_failure", code: "revision_digest" }),
      ];
      const integrityList = await app.inject({ method: "GET", url: "/api/v1/plans" });
      expect(integrityList.statusCode).toBe(500);
      expect(integrityList.json()).toEqual({ detail: "Accepted Plan data is inconsistent" });
      expect(integrityList.json()).not.toHaveProperty("profiles");

      const details: ReadonlyArray<
        readonly [AcceptedProfileProgress, number, Readonly<Record<string, string>>]
      > = [
        [
          { kind: "unavailable", reason: "compatibility_dirty" },
          409,
          { detail: "Accepted Plan requires compatibility repair" },
        ],
        [
          { kind: "unavailable", reason: "uninitialized" },
          409,
          { detail: "Accepted Plan operational state is not initialized" },
        ],
        [
          { kind: "concurrent_update" },
          409,
          { detail: "Accepted Plan changed; reload and retry" },
        ],
        [
          { kind: "integrity_failure", code: "revision_digest" },
          500,
          { detail: "Accepted Plan data is inconsistent" },
        ],
      ];
      for (const [progress, status, body] of details) {
        ports.repository.readAcceptedProfileSummary = () => ({
          kind: "found",
          summary: summary(firstHeader, progress),
        });
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/plans/${first.id}`,
        });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toEqual(body);
      }

      ports.repository.listAcceptedProfileSummaries = () => {
        throw new Error("private collection sentinel");
      };
      const unexpected = await app.inject({ method: "GET", url: "/api/v1/plans" });
      expect(unexpected.statusCode).toBe(500);
      expect(unexpected.json()).toEqual({ detail: "Internal Server Error" });
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("rejects v1 metadata mutations before their first write when Progress is unavailable", async () => {
    const { app, ports } = await fixture();
    try {
      const plan = ports.repository.createProfile("Stable name");
      const header = ports.repository.getProfileHeader(plan.id)!;
      ports.repository.readAcceptedProfileSummary = () => ({
        kind: "found",
        summary: summary(header, { kind: "unavailable", reason: "uninitialized" }),
      });

      for (const request of [
        {
          method: "PATCH" as const,
          url: `/api/v1/plans/${plan.id}`,
          payload: { name: "Must not persist", special_request: "Must not persist" },
        },
        { method: "POST" as const, url: `/api/v1/plans/${plan.id}/touch` },
        { method: "POST" as const, url: `/api/v1/plans/${plan.id}/archive` },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          detail: "Accepted Plan operational state is not initialized",
        });
        expect(ports.repository.getProfileHeader(plan.id)).toEqual(header);
      }
    } finally {
      await app.close();
      ports.db.close();
    }
  });

  it("redacts unexpected summary failures from responses and logs", async () => {
    const { app, ports } = await fixture();
    const capturedErrors: unknown[][] = [];
    app.addHook("onRequest", (request, _reply, done) => {
      request.log.error = (...args: unknown[]) => {
        capturedErrors.push(args);
      };
      done();
    });
    try {
      const plan = ports.repository.createProfile("Private Plan name");
      const sentinelParts = [
        "Private Plan name",
        "SELECT * FROM print_progress",
        "/private/accepted/path",
        "d".repeat(64),
        "ppu_0123456789abcdef0123456789abcdef",
      ];
      const failure = new Error(sentinelParts.join(" "));
      ports.repository.listAcceptedProfileSummaries = () => {
        throw failure;
      };
      const responses = [
        await app.inject({ method: "GET", url: "/api/v1/plans" }),
      ];

      ports.repository.readAcceptedProfileSummary = () => {
        throw failure;
      };
      responses.push(
        await app.inject({ method: "GET", url: `/api/v1/plans/${plan.id}` }),
        await app.inject({
          method: "PATCH",
          url: `/api/v1/plans/${plan.id}`,
          payload: { name: "Must not persist" },
        }),
        await app.inject({ method: "POST", url: `/api/v1/plans/${plan.id}/touch` }),
        await app.inject({ method: "POST", url: `/api/v1/plans/${plan.id}/archive` }),
      );

      for (const response of responses) {
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ detail: "Internal Server Error" });
      }
      const publicAndLogged = JSON.stringify({
        responses: responses.map((response) => response.json()),
        logs: capturedErrors,
      });
      for (const sentinel of sentinelParts) {
        expect(publicAndLogged).not.toContain(sentinel);
      }
      expect(capturedErrors).toHaveLength(5);
    } finally {
      await app.close();
      ports.db.close();
    }
  });
});
