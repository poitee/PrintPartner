// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineFetch } from "../../api/engineTransport";
import ReferenceSharePanel from "./ReferenceSharePanel";

vi.mock("../../api/engineTransport", () => ({ engineFetch: vi.fn(), engineFetchStream: vi.fn() }));
const manifest = {
  format: "printpartner-reference-share", version: 1, kind: "build", title: "My Build",
  sources: [], layers: [], parts: [], selections: {}, include: [], exclude: [], replacements: {},
};

describe("references-only Share panel", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:manifest"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(engineFetch).mockResolvedValue({ manifest, warnings: ["No model files are included."] });
  });
  it("previews and downloads the exact manifest without models or progress", async () => {
    render(<ReferenceSharePanel profileId={7} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download manifest" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob)));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(document.querySelector("pre")?.textContent).toBe(JSON.stringify(manifest, null, 2));
    expect(engineFetch).toHaveBeenCalledWith("/plans/7/reference-share");
    expect(screen.getByText(/This does not push to Git/)).toBeTruthy();
    expect(screen.getByText("No model files are included.")).toBeTruthy();
  });
  it("reports export failure without offering broken downloads", async () => {
    vi.mocked(engineFetch).mockRejectedValue(new Error("Source unavailable"));
    render(<ReferenceSharePanel profileId={7} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Source unavailable");
    expect(screen.queryByRole("button", { name: "Download manifest" })).toBeNull();
  });
});
