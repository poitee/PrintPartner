import { describe, expect, it } from "vitest";
import {
  parseTextEmbeddedToolCalls,
  stripEmbeddedToolCallJson,
} from "./parse-text-tool-calls.js";

describe("parseTextEmbeddedToolCalls", () => {
  it("recovers fake get_source_docs JSON from llama-style text", () => {
    const content = `To look up docs I will call:
{"name": "get_source_docs", "parameters": {"query": "", "source_id": "-1", "source_name": "Voron Trident"}}
`;
    const calls = parseTextEmbeddedToolCalls(content);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("get_source_docs");
    expect(calls[0]!.input.source_name).toBe("Voron Trident");
    expect(calls[0]!.input.source_id).toBe("-1");
  });

  it("does not recover invented recompute calls outside Plan", () => {
    const content =
      'After applying, run `call ["recompute_build"]` with no arguments to regenerate the parts list.';
    const calls = parseTextEmbeddedToolCalls(content);
    expect(calls).toHaveLength(0);
    expect(stripEmbeddedToolCallJson(content)).not.toMatch(/recompute_build/);
  });

  it("recovers prose narration of get_build_recipe and strips scaffolding", () => {
    const content = `To answer your question, I will call the \`get_build_recipe\` function to derive the current build recipe (base@ref, addons, selections, recent decisions) as structured JSON + markdown.

Here is a possible response:
`;
    const calls = parseTextEmbeddedToolCalls(content);
    expect(calls.some((c) => c.name === "get_build_recipe")).toBe(true);
    const stripped = stripEmbeddedToolCallJson(content);
    expect(stripped).not.toMatch(/get_build_recipe/);
    expect(stripped).not.toMatch(/possible response/i);
  });

  it("does not strip ordinary prose that says use <source name>", () => {
    const content =
      "I cannot use FakePrinterKit-9000 — that source is not in your library.";
    expect(stripEmbeddedToolCallJson(content)).toBe(content);
  });

});
