// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReferenceShare } from "@print-partner/contracts";
import { fetchSources } from "../../api/endpoints/sources";
import { engineFetch } from "../../api/engineTransport";
import ReferenceShareImport from "./ReferenceShareImport";

vi.mock("../../api/endpoints/sources", () => ({ fetchSources: vi.fn() }));
vi.mock("../../api/engineTransport", () => ({ engineFetch: vi.fn() }));

const manifest = {
  format: "printpartner-reference-share",
  version: 1,
  kind: "build",
  title: "Shared",
  sources: [{
    key: "source-1",
    name: "Voron",
    location: { kind: "publisher", url: "https://github.com/VoronDesign/Voron-2" },
    revision: { branch: "main", tag: null, commit: "a".repeat(40) },
    file_rules: ["parts/a.stl"],
  }],
  layers: [{ source: "source-1", role: "base" }],
  selections: {},
  include: ["parts/a.stl"],
  exclude: [],
  replacements: {},
  parts: [{ source: "source-1", path: "parts/a.stl", quantity: 1, included: true, role: "primary", color: null }],
} as Extract<ReferenceShare, { kind: "build" }>;

describe("ReferenceShareImport", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not preselect a Library Source with the same name", async () => {
    vi.mocked(fetchSources).mockResolvedValue([
      { id: 4, name: "Voron" } as Awaited<ReturnType<typeof fetchSources>>[number],
    ]);
    render(
      <MemoryRouter>
        <ReferenceShareImport manifest={manifest} />
      </MemoryRouter>,
    );
    const select = await screen.findByLabelText("Map Voron");
    expect(select).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Add to my Builds" })).toHaveProperty("disabled", true);
    expect(engineFetch).not.toHaveBeenCalled();
  });

  it("imports only after the mapped files are Ready", async () => {
    vi.mocked(fetchSources).mockResolvedValue([
      { id: 9, name: "Acquired Voron" } as Awaited<ReturnType<typeof fetchSources>>[number],
    ]);
    vi.mocked(engineFetch)
      .mockResolvedValueOnce({
        printable: true,
        dependencies: [{ source_key: "source-1", path: "parts/a.stl", status: "Ready" }],
      })
      .mockResolvedValueOnce({ profile_id: 15 });
    render(
      <MemoryRouter initialEntries={["/board/p1"]}>
        <Routes>
          <Route path="/board/p1" element={<ReferenceShareImport manifest={manifest} />} />
          <Route path="/plan" element={<p>Plan opened</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByLabelText("Map Voron"), { target: { value: "9" } });
    expect(await screen.findByText("parts/a.stl: Ready")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to my Builds" }));
    expect(await screen.findByText("Plan opened")).toBeTruthy();
    expect(engineFetch).toHaveBeenLastCalledWith("/reference-shares/imports", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"source-1":9'),
    }));
  });
});
