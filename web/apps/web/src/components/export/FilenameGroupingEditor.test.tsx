// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { miloFilenameGrouping } from "@print-partner/contracts";
import FilenameGroupingEditor from "./FilenameGroupingEditor";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../api/engineTransport", () => ({ engineFetch: api.fetch }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("filename grouping editor", () => {
  it("previews groups, intersects color and group, and resolves conflicts with an override", async () => {
    api.fetch.mockResolvedValue({ definition: miloFilenameGrouping, parts: [
      { relativePath: "[a]-mount-S.stl", sourceLayer: "base", role: "accent", units: [{ token: "mount-1", completed: false }, { token: "mount-2", completed: false }] },
      { relativePath: "cover-A.stl", sourceLayer: "base", role: "primary", units: [{ token: "cover-1", completed: false }] },
    ] });
    const onChange = vi.fn();
    render(<FilenameGroupingEditor profileId={7} onChange={onChange} />);
    await screen.findByLabelText("Grouping name");
    fireEvent.change(screen.getByLabelText("Color role"), { target: { value: "accent" } });
    fireEvent.change(screen.getByLabelText("Export group"), { target: { value: "Structural" } });
    expect(onChange).toHaveBeenLastCalledWith({ definition: miloFilenameGrouping, arrangement: "color_group", role: "accent", group: "Structural" });
    fireEvent.change(screen.getByLabelText("Export group"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filename suffix 1"), { target: { value: "S" } });
    expect(screen.getByRole("alert").textContent).toContain("different groups");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    fireEvent.change(screen.getByLabelText("Override base: [a]-mount-S.stl"), { target: { value: "Structural" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save groups" }));
    await waitFor(() => expect(api.fetch).toHaveBeenCalledWith("/plans/7/filename-grouping", expect.objectContaining({ method: "PUT" })));
    await screen.findByText("Filename groups saved for this Build.");
  });

  it("blocks only conflicting parts within the selected units and remaining scope", async () => {
    const definition = {
      ...miloFilenameGrouping,
      rules: [...miloFilenameGrouping.rules, { suffix: "S", group: "Other" }],
    };
    api.fetch.mockResolvedValue({ definition, parts: [
      { relativePath: "cover-A.stl", sourceLayer: "base", role: "primary", units: [{ token: "clean", completed: false }] },
      { relativePath: "finished-S.stl", sourceLayer: "base", role: "primary", units: [{ token: "finished", completed: true }] },
      { relativePath: "unselected-S.stl", sourceLayer: "base", role: "primary", units: [{ token: "unselected", completed: false }] },
    ] });
    const onChange = vi.fn();
    const { rerender } = render(<FilenameGroupingEditor profileId={7} onChange={onChange} selectedTokens={["clean", "finished"]} scope="remaining" />);
    await screen.findByLabelText("Grouping name");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ definition, arrangement: "color_group" });

    rerender(<FilenameGroupingEditor profileId={7} onChange={onChange} selectedTokens={["clean", "finished"]} scope="all" />);
    expect(screen.getByRole("alert").textContent).toContain("different groups");
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    rerender(<FilenameGroupingEditor profileId={7} onChange={onChange} selectedTokens={["clean"]} scope="all" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ definition, arrangement: "color_group" });

    rerender(<FilenameGroupingEditor profileId={7} onChange={onChange} selectedTokens={[]} scope="remaining" />);
    expect(screen.getByRole("alert").textContent).toContain("different groups");
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("does not enable export if loading the rules fails", async () => {
    api.fetch.mockRejectedValue(new Error("unavailable"));
    const onChange = vi.fn();
    render(<FilenameGroupingEditor profileId={7} onChange={onChange} />);
    await screen.findByText(/Could not load filename groups/);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
