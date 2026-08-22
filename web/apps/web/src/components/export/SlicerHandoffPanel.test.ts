import { describe, expect, it, vi } from "vitest";
import { completeManagedSlicerOpen } from "./SlicerHandoffPanel";

describe("managed slicer popup completion", () => {
  it("navigates a reserved popup to the managed slicer", () => {
    const navigate = vi.fn();
    expect(completeManagedSlicerOpen({ navigate, close: vi.fn() }, "https://slicer.example.test")).toEqual({
      kind: "opened",
    });
    expect(navigate).toHaveBeenCalledWith("https://slicer.example.test");
  });

  it("returns the manual fallback when the popup was blocked", () => {
    expect(completeManagedSlicerOpen(null, "https://slicer.example.test")).toEqual({
      kind: "manual",
      guiUrl: "https://slicer.example.test",
    });
  });
});
