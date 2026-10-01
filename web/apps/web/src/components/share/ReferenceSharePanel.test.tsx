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
  it("rejects oversized manifests before reading or sending their contents", async () => {
    render(<ReferenceSharePanel profileId={7} />);
    await screen.findByRole("button", { name: "Download manifest" });
    const text = vi.fn();
    fireEvent.change(screen.getByLabelText("Choose reference manifest JSON"), {
      target: { files: [{ size: 4 * 1024 * 1024 + 1, text }] },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("4 MiB");
    expect(text).not.toHaveBeenCalled();
    expect(engineFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^Valid /)).toBeNull();
  });
  it("allows the same received file to be retried after validation fails", async () => {
    render(<ReferenceSharePanel profileId={7} />);
    await screen.findByRole("button", { name: "Download manifest" });
    vi.mocked(engineFetch).mockRejectedValueOnce(new Error("Invalid manifest JSON"));
    const file = { size: 12, text: vi.fn().mockResolvedValue("{invalid") };
    const input = screen.getByLabelText("Choose reference manifest JSON") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid manifest JSON");
    expect(input.value).toBe("");
    expect(input.disabled).toBe(false);
    expect(screen.queryByText(/^Valid /)).toBeNull();
    vi.mocked(engineFetch).mockResolvedValueOnce({ manifest: { ...manifest, kind: "collection" }, warnings: [] });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText(/Valid collection: My Build/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(engineFetch).toHaveBeenCalledTimes(3);
  });
});
