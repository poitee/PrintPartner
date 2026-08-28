// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrinterCameraView from "./PrinterCameraView";
import { host, printer } from "./testFixtures";

const api = vi.hoisted(() => ({ fetchPrinterCameras: vi.fn() }));

vi.mock("../../api/endpoints/printers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/endpoints/printers")>()),
  fetchPrinterCameras: api.fetchPrinterCameras,
  printerCameraViewUrl: () => "/camera-view",
}));

describe("PrinterCameraView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchPrinterCameras.mockResolvedValue([
      { id: "chamber", name: "Chamber", view: "mjpeg" },
    ]);
  });

  afterEach(cleanup);

  it("shows the discovered camera and says how it is served", async () => {
    render(<PrinterCameraView printer={printer} host={host} />);

    expect(await screen.findByAltText("Chamber view of Voron One")).toBeTruthy();
    expect(screen.getByText(/proxied through PrintPartner/)).toBeTruthy();
  });

  it("keeps a failed discovery on screen with a Retry that reruns it", async () => {
    api.fetchPrinterCameras.mockRejectedValueOnce(new Error("Host timed out"));
    render(<PrinterCameraView printer={printer} host={host} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not discover cameras on Voron One");
    expect(alert.textContent).toContain("Host timed out");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByAltText("Chamber view of Voron One")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("routes a PrusaLink operator to Connect rather than pretending to play RTSP", async () => {
    api.fetchPrinterCameras.mockResolvedValue([]);
    render(
      <PrinterCameraView printer={printer} host={{ ...host, type: "prusalink" }} />,
    );

    expect(await screen.findByText(/LAN-only, unencrypted RTSP stream/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Prusa Connect" }).getAttribute("href")).toBe(
      "https://connect.prusa3d.com/",
    );
  });

  it("gives a Moonraker operator a way to look again", async () => {
    api.fetchPrinterCameras.mockResolvedValue([]);
    render(<PrinterCameraView printer={printer} host={host} />);

    fireEvent.click(await screen.findByRole("button", { name: "Look again" }));

    expect(api.fetchPrinterCameras).toHaveBeenCalledTimes(2);
  });
});
