import { describe, expect, it } from "vitest";
import { ASSISTANT_TOOL_SPECS } from "../assistant/tools.js";

describe("mcp product tools", () => {
  it("exposes non-ui assistant verbs for MCP listing", () => {
    const product = ASSISTANT_TOOL_SPECS.filter((t) => !t.name.startsWith("ui_"));
    expect(product.some((t) => t.name === "get_kit_catalog")).toBe(true);
    expect(product.some((t) => t.name === "ingest_guide_url")).toBe(true);
    expect(product.some((t) => t.name === "add_addon")).toBe(true);
    expect(product.some((t) => t.name === "get_remaining")).toBe(true);
    expect(product.some((t) => t.name === "duplicate_plan")).toBe(true);
    expect(product.some((t) => t.name === "archive_plan")).toBe(true);
    expect(product.some((t) => t.name === "get_plan_snapshot")).toBe(true);
    expect(product.some((t) => t.name === "get_build_workflow")).toBe(true);
    expect(product.some((t) => t.name === "list_sources")).toBe(true);
    expect(product.every((t) => !t.name.startsWith("ui_"))).toBe(true);
    expect(product.every((t) => t.name !== "start_print")).toBe(true);
    expect(product.length).toBeGreaterThan(20);
  });

  it("mutate tools are tagged so MCP can annotate confirm-to-apply", () => {
    const mutate = ASSISTANT_TOOL_SPECS.filter((t) => t.tier === "mutate");
    expect(mutate.some((t) => t.name === "propose_add_source")).toBe(true);
    expect(mutate.some((t) => t.name === "duplicate_plan")).toBe(true);
    expect(mutate.some((t) => t.name === "archive_plan")).toBe(true);
    expect(mutate.every((t) => t.tier === "mutate")).toBe(true);
  });

  it("does not let MCP create publication blockers", () => {
    const rebuild = ASSISTANT_TOOL_SPECS.find((tool) => tool.name === "propose_rebuild_plan");
    const publish = ASSISTANT_TOOL_SPECS.find((tool) => tool.name === "propose_apply_plan_draft");

    expect(rebuild?.input_schema.properties).not.toHaveProperty("review_blockers");
    expect(publish?.description).toContain("Preparation notes remain advisory");
    expect(publish?.description).not.toMatch(/readiness must pass|block/i);
  });
});
