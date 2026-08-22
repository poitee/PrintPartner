import { describe, expect, it, vi } from "vitest";
import {
  extractGuideAdvice,
  fetchWebPageText,
  htmlToPlainText,
  ingestGuideText,
  ingestGuideUrl,
  refineGuideExtractWithLlm,
  type GuideExtractLlm,
} from "./guide-ingest.js";

describe("guide ingest", () => {
  it("htmlToPlainText strips tags and scripts", () => {
    const text = htmlToPlainText(
      `<html><script>alert(1)</script><body><h1>Tap</h1><p>Replaces stock probe</p></body></html>`,
    );
    expect(text).toContain("Tap");
    expect(text).toContain("Replaces stock probe");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("<");
  });

  it("extracts github link + stock probe replacement from fixture HTML", () => {
    const html = `
      <html><body>
        <h1>Voron Tap for Trident</h1>
        <p>This mod replaces the stock probe / nozzle_probe on Voron-Trident (VTr2).</p>
        <p>Also remove stock z_endstop.</p>
        <a href="https://github.com/VoronDesign/Voron-Tap">GitHub</a>
        <a href="https://www.printables.com/model/123">Printables</a>
      </body></html>
    `;
    const text = htmlToPlainText(html);
    const extract = extractGuideAdvice(text, { html });
    expect(extract.detected_printer_or_base).toBe("Voron-Trident");
    expect(extract.links.some((l) => l.kind === "github" && l.url.includes("Voron-Tap"))).toBe(
      true,
    );
    expect(
      extract.replacements.length > 0 ||
        extract.required_addons.includes("Voron-Tap") ||
        /probe|stock/i.test(extract.replacements.join(" ")),
    ).toBe(true);
    expect(extract.required_addons).toEqual(expect.arrayContaining(["Voron-Tap"]));
    expect(["medium", "high"]).toContain(extract.confidence);
  });

  it("does not inflate required_addons for comparison mentions of Klicky/Unklicky", () => {
    const text =
      "Voron Tap for Trident. Unlike Klicky and Unklicky, Tap docks to the toolhead. " +
      "Replaces stock probe. https://github.com/VoronDesign/Voron-Tap";
    const extract = extractGuideAdvice(text);
    expect(extract.required_addons).toEqual(expect.arrayContaining(["Voron-Tap"]));
    expect(extract.required_addons).not.toContain("Klicky-Probe");
    expect(extract.open_questions.some((q) => /Klicky/i.test(q))).toBe(true);
  });

  it("LDO Trident kit page: Voron-Trident base, LDO addons, optional Klicky not required", () => {
    const html = `
      <html><body>
        <h1>Voron Trident Kit | LDO Documentation</h1>
        <p>Thank you for purchasing the LDO Voron Trident Kit!</p>
        <p>Nevermore Filter - Instead of the stock exhaust we include parts for the Nevermore Micro V5.</p>
        <p>Klicky Mod - Instead of the included Omron inductive probe, We also provide the parts to build your machine using the optional Klicky mod by jlas1.</p>
        <a href="https://github.com/jlas1/Klicky-Probe">Klicky</a>
        <a href="https://github.com/VoronDesign/Voron-Trident/tree/main/CAD">CAD</a>
        <a href="https://github.com/VoronDesign/Voron-2/blob/Voron2.4/STLs/TEST_PRINTS/Voron_Design_Cube_v7.stl">Cube</a>
        <p>Printed Parts Guide (LDO supplement)</p>
      </body></html>
    `;
    const text = htmlToPlainText(html);
    const extract = extractGuideAdvice(text, { html });
    expect(extract.detected_printer_or_base).toBe("Voron-Trident");
    expect(extract.required_addons).toContain("LDOVoronTrident");
    expect(extract.required_addons).not.toContain("Klicky-Probe");
    expect(extract.required_addons).not.toContain("LDOVoron2");
    expect(extract.open_questions.some((q) => /Klicky/i.test(q))).toBe(true);
  });

  it("ingestGuideText returns banner + extract", async () => {
    const result = await ingestGuideText(
      "Install Klicky-Probe on Voron-2. Replaces inductive probe. https://github.com/jlas1/Klicky-Probe",
    );
    expect(result.ok).toBe(true);
    expect(result.banner).toMatch(/UNTRUSTED/i);
    expect(result.extract_method).toBe("heuristic");
    expect(result.extract.required_addons).toEqual(expect.arrayContaining(["Klicky-Probe"]));
    expect(result.extract.links.some((l) => l.kind === "github")).toBe(true);
  });

  it("ingestGuideUrl uses fetchFn and respects SSRF-safe path", async () => {
    const html = `<html><body><p>Voron-Trident Tap guide replaces stock probe</p>
      <a href="https://github.com/VoronDesign/Voron-Tap">repo</a></body></html>`;
    const fetchFn = vi.fn(async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    ) as unknown as typeof import("../lib/outbound-url.js").safeOutboundFetch;

    const result = await ingestGuideUrl("https://example.com/guide", { fetchFn });
    expect(result.ok).toBe(true);
    expect(result.extract.links.some((l) => l.kind === "github")).toBe(true);
    expect(result.untrusted_text).toMatch(/Tap|probe/i);
  });

  it("fetchWebPageText returns title + text without GuideExtract", async () => {
    const html = `<html><head><title>Docs</title></head><body><p>Plain page</p></body></html>`;
    const fetchFn = vi.fn(async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    ) as unknown as typeof import("../lib/outbound-url.js").safeOutboundFetch;

    const page = await fetchWebPageText("https://example.com/page", { fetchFn });
    expect(page.ok).toBe(true);
    expect(page.title).toBe("Docs");
    expect(page.text).toMatch(/Plain page/);
    expect(page.untrusted_banner).toMatch(/UNTRUSTED/i);
    expect(page).not.toHaveProperty("extract");
  });

  it("seeds Voron-Tap subject from raw.githubusercontent.com guide URL", async () => {
    const md = `# Voron Tap\nUnlike Klicky, Tap docks to the toolhead.\n`;
    const fetchFn = vi.fn(async () =>
      new Response(md, { status: 200, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof import("../lib/outbound-url.js").safeOutboundFetch;

    const result = await ingestGuideUrl(
      "https://raw.githubusercontent.com/VoronDesign/Voron-Tap/main/README.md",
      { fetchFn },
    );
    expect(result.ok).toBe(true);
    expect(result.extract.required_addons).toEqual(expect.arrayContaining(["Voron-Tap"]));
    expect(result.extract.required_addons).not.toContain("Klicky-Probe");
    expect(
      result.extract.links.some(
        (l) => l.kind === "github" && /Voron-Tap/i.test(l.url),
      ),
    ).toBe(true);
    expect(result.extract.notes.some((n) => /Voron-Tap/i.test(n))).toBe(true);
    expect(
      result.extract.open_questions.some(
        (q) => /Voron-Tap/i.test(q) && /alternative|comparison/i.test(q),
      ),
    ).toBe(false);
  });

  it("LLM refine pass prefers structured required_addons and falls back on failure", async () => {
    const text =
      "Tap guide for Voron-Trident. Mentions Klicky and Unklicky as alternatives. " +
      "https://github.com/VoronDesign/Voron-Tap";
    const heuristic = extractGuideAdvice(text);
    expect(heuristic.required_addons).not.toContain("Klicky-Probe");

    const llm: GuideExtractLlm = {
      configured: true,
      model: "test-model",
      complete: async () =>
        JSON.stringify({
          detected_printer_or_base: "Voron-Trident",
          tags_or_refs: [],
          required_addons: ["Voron-Tap"],
          replacements: ["stock probe"],
          open_questions: [],
          confidence: "high",
          notes: ["refined"],
        }),
    };
    const refined = await refineGuideExtractWithLlm(text, heuristic, llm);
    expect(refined?.required_addons).toEqual(["Voron-Tap"]);
    expect(refined?.notes.some((n) => /LLM-refined/i.test(n))).toBe(true);
    expect(refined?.links.some((l) => l.kind === "github")).toBe(true);

    const broken: GuideExtractLlm = {
      configured: true,
      model: "test-model",
      complete: async () => {
        throw new Error("provider down");
      },
    };
    expect(await refineGuideExtractWithLlm(text, heuristic, broken)).toBeNull();

    const viaIngest = await ingestGuideText(text, { llm });
    expect(viaIngest.extract_method).toBe("llm");
    expect(viaIngest.extract.required_addons).toEqual(["Voron-Tap"]);
    expect(viaIngest.banner).toMatch(/UNTRUSTED/i);
  });

  it("LLM refine filters invented addon names to catalog (or open_questions)", async () => {
    const text =
      "Tap for Voron-Trident. Mentions Klicky as alternative. https://github.com/VoronDesign/Voron-Tap";
    const heuristic = extractGuideAdvice(text);
    const inventing: GuideExtractLlm = {
      configured: true,
      model: "test-model",
      complete: async () =>
        JSON.stringify({
          detected_printer_or_base: "Some Fantasy Printer",
          required_addons: ["Klipper", "Unklicky_TAP", "Tap", "Klicky-Probe"],
          replacements: [],
          open_questions: [],
          confidence: "high",
          notes: [],
        }),
    };
    const refined = await refineGuideExtractWithLlm(text, heuristic, inventing);
    expect(refined).not.toBeNull();
    expect(refined!.required_addons).toEqual(["Voron-Tap"]);
    expect(refined!.required_addons).not.toContain("Klipper");
    expect(refined!.required_addons).not.toContain("Unklicky_TAP");
    expect(refined!.required_addons).not.toContain("Klicky-Probe");
    expect(refined!.detected_printer_or_base).toBe(heuristic.detected_printer_or_base);
    expect(
      refined!.open_questions.some((q) => /Klipper|Unklicky|Klicky-Probe/i.test(q)),
    ).toBe(true);
  });

  it("URL seed drops comparison peers even if LLM listed them as required", async () => {
    const md =
      "# Voron Tap\nUnlike Klicky and Unklicky, Tap docks to the toolhead.\n" +
      "See also https://github.com/majarspeed/Unklicky/tree/main/Unklicky_TAP\n";
    const fetchFn = vi.fn(async () =>
      new Response(md, { status: 200, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof import("../lib/outbound-url.js").safeOutboundFetch;

    const inventing: GuideExtractLlm = {
      configured: true,
      model: "test-model",
      complete: async () =>
        JSON.stringify({
          detected_printer_or_base: "Voron-Trident",
          required_addons: ["Voron-Tap", "Klicky-Probe"],
          replacements: [],
          open_questions: [],
          confidence: "high",
          notes: [],
        }),
    };

    const result = await ingestGuideUrl(
      "https://raw.githubusercontent.com/VoronDesign/Voron-Tap/main/README.md",
      { fetchFn, llm: inventing },
    );
    expect(result.ok).toBe(true);
    expect(result.extract.required_addons).toEqual(["Voron-Tap"]);
    expect(result.extract.required_addons).not.toContain("Klicky-Probe");
  });

  it("treats hardware kit product pages as BOM evidence (generic, no kit-name detector)", () => {
    const text = `
      Expandable multi-material 5-lane kit SKU for klipper printer voron BMCU ERCF
      Note: This kit does not include any printed parts or the control board (EBB42).
      What you will receive: This kit includes all parts and electronic accessories except the controller board (EBB42).
      That means you need to purchase 5x EBB42 boards separately for this unit to function fully.
      More information: https://github.com/ExampleOrg/ExampleMMU
      Off-the-shelf electronics (EBB42 with EBB36 also fully compatible).
    `;
    const html = `<a href="https://github.com/ExampleOrg/ExampleMMU">More information</a>`;
    const extract = extractGuideAdvice(text, { html });
    expect(extract.detected_printer_or_base).toBeNull();
    expect(extract.notes.some((n) => /not an STL source|BOM/i.test(n))).toBe(true);
    expect(extract.notes.some((n) => /printed parts/i.test(n))).toBe(true);
    expect(extract.notes.some((n) => /controller boards|boards separately/i.test(n))).toBe(true);
    expect(extract.notes.some((n) => /5-lane|5 lanes/i.test(n))).toBe(true);
    expect(extract.notes.some((n) => /Standalone project|linked GitHub source/i.test(n))).toBe(
      true,
    );
    expect(extract.links.some((l) => /ExampleOrg\/ExampleMMU/i.test(l.url))).toBe(true);
    expect(extract.open_questions.some((q) => /electronics board/i.test(q))).toBe(true);
    expect(extract.open_questions.some((q) => /No GitHub repo link/i.test(q))).toBe(false);
    expect(extract.open_questions.some((q) => /keep plan base/i.test(q))).toBe(false);
  });
});
