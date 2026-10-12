import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptedOperationalExport } from "../services/accepted-operational-export.js";
import { materializeAcceptedChecklistHtml } from "../services/export-html.js";

export const exportHtmlFixtureRoot = fileURLToPath(
  new URL("../../../../../fixtures/parity/export-html/", import.meta.url),
);

export type ChecklistFixture = Pick<AcceptedOperationalExport, "profile" | "parts"> & {
  generatedAt: string;
};

export function checklistFixtureNames(): string[] {
  return readdirSync(join(exportHtmlFixtureRoot, "input"))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

export function readChecklistFixture(name: string): ChecklistFixture {
  return JSON.parse(readFileSync(join(exportHtmlFixtureRoot, "input", name), "utf8"));
}

// Normalize runtime identities before rendering. Never rewrite HTML: changes to
// escaping, ordering, date formatting, styling, and checkoff must remain visible.
export function renderChecklistFixture(fixture: ChecklistFixture) {
  const temporary = mkdtempSync(join(tmpdir(), "export-html-golden-"));
  try {
    const result = materializeAcceptedChecklistHtml({
      capture: {
        kind: "ready",
        export: {
          profile: { ...fixture.profile, id: 1, archivedAt: null },
          provenance: { kind: "legacy" },
          basis: {
            profileId: 1,
            planVersion: 1,
            revisionId: 1,
            revisionDigest: "a".repeat(64),
            requiredUnitMappingDigest: "b".repeat(64),
          },
          parts: fixture.parts.map((part, index) => ({
            ...part,
            revisionPartId: index + 1,
            projectionPartId: index + 1,
            spoolmanSpoolId: null,
            units: part.units.map((unit) => ({
              ...unit,
              token: `part-${index + 1}:unit-${unit.unitIndex}`,
            })),
          })),
        },
      },
      generatedAt: "2000-01-01T00:00:00.000Z",
      dateFormat: "iso",
      tenantExportsDir: join(temporary, "exports"),
      thumbsDir: join(temporary, "thumbs"),
    });
    if (result.kind !== "materialized") throw new Error("Checklist materialization failed");
    return {
      html: readFileSync(result.path, "utf8"),
      partCount: result.partCount,
      thumbCount: result.thumbCount,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
