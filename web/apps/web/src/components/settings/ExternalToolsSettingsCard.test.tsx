// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalAccessMode } from "@print-partner/contracts";
import ExternalToolsSettingsCard from "./ExternalToolsSettingsCard";

const state = vi.hoisted(() => {
  const mode: ExternalAccessMode = "api_and_mcp";
  return { mode, mutate: vi.fn() };
});

vi.mock("../../queries/externalAccess", () => ({
  useExternalAccessSettingsQuery: () => ({
    data: { mode: state.mode },
    error: null,
  }),
  useSaveExternalAccessSettingsMutation: () => ({
    mutate: state.mutate,
    isPending: false,
    error: null,
  }),
}));

describe("ExternalToolsSettingsCard", () => {
  afterEach(cleanup);

  beforeEach(() => {
    state.mode = "api_and_mcp";
    state.mutate.mockReset();
  });

  it("presents one simple choice instead of separate dependent switches", () => {
    render(<ExternalToolsSettingsCard engineReady />);

    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Off, keep it simple/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /API access/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /API and MCP/i })).toBeTruthy();
  });

  it("saves the off mode from the plain-language option", () => {
    render(<ExternalToolsSettingsCard engineReady />);

    fireEvent.click(screen.getByRole("radio", { name: /Off, keep it simple/i }));

    expect(state.mutate).toHaveBeenCalledWith({ mode: "off" });
  });
});
