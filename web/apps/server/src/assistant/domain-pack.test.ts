import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import {
  ADVISOR_NOTE_TITLES,
  backfillAdvisorNotesFromDomainPack,
  importAssistantDomainPack,
  loadAssistantDomainPack,
} from "./domain-pack.js";

describe("assistant domain pack", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("loads seed alias map from shipped assistant-domain data", () => {
    const pack = loadAssistantDomainPack();
    expect(pack).toContain("Domain pack");
    expect(pack).toContain("LDO Trident R2");
    expect(pack).toContain("Voron-Trident");
    expect(pack).toContain("VTr2");
    // Research-format aliases must not render as empty phrases
    expect(pack).not.toMatch(/"" →/);
    expect(pack).toMatch(/base=Voron-Trident@VTr2/);
    expect(pack).toContain("### Source digests");
    // Capped workflow / pitfalls excerpts from on-disk research md
    expect(pack).toMatch(/workflow:/);
    expect(pack).toMatch(/pitfalls:/);
    // Compatibility digest lines from print-partner/compat@1
    expect(pack).toMatch(/compat:/);
    expect(pack).toMatch(/conflicts=/);
  });

  it("normalizes research-format alias and stack YAML", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-domain-"));
    dirs.push(dataDir);
    const result = importAssistantDomainPack(
      {
        write_files: true,
        global: {
          alias_map: {
            schema: "print-partner/aliases@1",
            aliases: [
              {
                phrase: "LDO Trident R2 / trident r2",
                source_name: "Voron-Trident",
                ref: "VTr2",
                addons: ["LDOVoronTrident@master"],
              },
            ],
          },
          stacks: {
            schema: "print-partner/stacks@1",
            stacks: [
              {
                name: "LDO Trident R2",
                base: { source_name: "Voron-Trident", ref: "VTr2" },
                addons: [{ source_name: "LDOVoronTrident", ref: "master" }],
              },
            ],
          },
          merge_conflicts: {
            conflicts: [
              {
                id: "probe_slot",
                stacks: ["base + Tap"],
                paths: ["z_endstop.stl"],
                resolution: "one probe",
              },
            ],
          },
        },
      },
      { dataDir, repo: null },
    );
    expect(result.wrote_files).toBe(true);
    const pack = loadAssistantDomainPack({ dataDir });
    expect(pack).toContain("LDO Trident R2");
    expect(pack).toContain("source=Voron-Trident");
    expect(pack).toContain("tag=VTr2");
    expect(pack).toContain("LDO Trident R2: base=Voron-Trident@VTr2");
    expect(pack).toContain("probe_slot");
    expect(pack).not.toMatch(/"" →/);
  });

  it("imports research payload into dataDir and returns notes count 0 without matching sources", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-domain-"));
    dirs.push(dataDir);
    const result = importAssistantDomainPack(
      {
        write_files: true,
        global: {
          pitfalls_md: "- imported pitfall\n",
          alias_map: {
            version: 1,
            aliases: [
              {
                phrases: ["test phrase"],
                resolve: { source_name: "Voron-2", tag: null },
              },
            ],
          },
        },
        sources: [
          {
            source_name: "Voron-2",
            identity: { source_name: "Voron-2", role: "base", summary: "Stock 2.4" },
            notes: [{ title: "Workflow", body_markdown: "Sync then attach as base." }],
          },
        ],
      },
      { dataDir, repo: null },
    );
    expect(result.wrote_files).toBe(true);
    expect(result.sources_written).toContain("Voron-2");
    expect(result.notes_created).toBe(0);
    const pitfalls = readFileSync(
      join(dataDir, "assistant-domain", "_global", "pitfalls.md"),
      "utf8",
    );
    expect(pitfalls).toContain("imported pitfall");
    const pack = loadAssistantDomainPack({ dataDir });
    expect(pack).toContain("test phrase");
    expect(pack).toContain("Voron-2");
  });

  it("imports workflow/pitfalls/quotes as Advisor source_notes when source matches", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-domain-notes-"));
    dirs.push(dataDir);
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    const source = repo.createSource({
      name: "Voron-Trident",
      url: "https://github.com/example/trident",
      source_kind: "github",
    });

    const result = importAssistantDomainPack(
      {
        write_files: true,
        backfill_notes: false,
        sources: [
          {
            source_name: "Voron-Trident",
            identity: { source_name: "Voron-Trident", role: "base", summary: "Trident" },
            workflow_md: "# Workflow\n1. Sync then attach as base.\n",
            pitfalls_md: "# Pitfalls\n- Wrong tag\n",
            quotes_md: "> cite README.md @ VTr2\n",
          },
        ],
      },
      { dataDir, repo },
    );

    expect(result.notes_created).toBeGreaterThanOrEqual(3);
    expect(result.sources_matched_for_notes).toBe(1);
    const notes = repo.listSourceNotes(source.id);
    expect(notes.map((n) => n.title).sort()).toEqual(
      [
        ADVISOR_NOTE_TITLES.pitfalls,
        ADVISOR_NOTE_TITLES.quotes,
        ADVISOR_NOTE_TITLES.workflow,
      ].sort(),
    );
    expect(notes.find((n) => n.title === ADVISOR_NOTE_TITLES.workflow)?.body_markdown).toContain(
      "Sync then attach",
    );

    // Replace-on-import (upsert by stable title)
    importAssistantDomainPack(
      {
        write_files: true,
        backfill_notes: false,
        sources: [
          {
            source_name: "Voron-Trident",
            workflow_md: "# Workflow\nUpdated body only.\n",
            pitfalls_md: "# Pitfalls\n- Still wrong tag\n",
            quotes_md: "> updated quote\n",
          },
        ],
      },
      { dataDir, repo },
    );
    const after = repo.listSourceNotes(source.id);
    expect(after).toHaveLength(3);
    expect(after.find((n) => n.title === ADVISOR_NOTE_TITLES.workflow)?.body_markdown).toContain(
      "Updated body only",
    );
  });

  it("backfills Advisor notes from on-disk pack for matching sources", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pp-domain-backfill-"));
    dirs.push(dataDir);
    const ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    const repo = ports.repository!;
    // Shipped pack includes Voron-Trident workflow.md etc.
    const source = repo.createSource({
      name: "Voron-Trident",
      url: "https://github.com/VoronDesign/Voron-Trident",
      source_kind: "github",
    });

    const backfill = backfillAdvisorNotesFromDomainPack(repo, dataDir);
    expect(backfill.sources_matched).toBeGreaterThanOrEqual(1);
    expect(backfill.notes_upserted).toBeGreaterThanOrEqual(1);
    const notes = repo.listSourceNotes(source.id);
    expect(notes.some((n) => n.title === ADVISOR_NOTE_TITLES.workflow)).toBe(true);
  });
});
