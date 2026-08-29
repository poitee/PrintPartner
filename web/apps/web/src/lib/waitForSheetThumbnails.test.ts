// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForSheetThumbnails } from "./waitForSheetThumbnails";

function sheetWithThumbs(
  thumbs: Array<
    | { kind: "placeholder" }
    | { kind: "img"; complete: boolean; naturalWidth: number; naturalHeight?: number }
  >,
): HTMLElement {
  const sheet = document.createElement("div");
  for (const thumb of thumbs) {
    const wrap = document.createElement("div");
    wrap.className = "sheet-thumb";
    if (thumb.kind === "img") {
      const img = document.createElement("img");
      img.className = "sheet-thumb-img";
      Object.defineProperty(img, "complete", { value: thumb.complete });
      Object.defineProperty(img, "naturalWidth", { value: thumb.naturalWidth });
      Object.defineProperty(img, "naturalHeight", {
        value: thumb.naturalHeight ?? thumb.naturalWidth,
      });
      wrap.appendChild(img);
    }
    sheet.appendChild(wrap);
  }
  return sheet;
}

describe("waitForSheetThumbnails", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a thumb with no image as pending after timeout", async () => {
    const sheet = sheetWithThumbs([{ kind: "placeholder" }]);
    await expect(waitForSheetThumbnails(sheet, 0)).resolves.toEqual({
      ready: false,
      pending: 1,
    });
  });

  it("treats a 1×1 placeholder PNG as pending, not ready", async () => {
    const sheet = sheetWithThumbs([
      { kind: "img", complete: true, naturalWidth: 1, naturalHeight: 1 },
    ]);
    await expect(waitForSheetThumbnails(sheet, 0)).resolves.toEqual({
      ready: false,
      pending: 1,
    });
  });

  it("is ready when every sheet image has loaded a real picture", async () => {
    const sheet = sheetWithThumbs([
      { kind: "img", complete: true, naturalWidth: 256, naturalHeight: 256 },
      { kind: "img", complete: true, naturalWidth: 96, naturalHeight: 96 },
    ]);
    await expect(waitForSheetThumbnails(sheet, 0)).resolves.toEqual({
      ready: true,
      pending: 0,
    });
  });

  it("does not give up at 4s while placeholders remain", async () => {
    vi.useFakeTimers();
    const sheet = sheetWithThumbs([{ kind: "placeholder" }]);
    const wait = waitForSheetThumbnails(sheet);
    let settled: unknown;
    void wait.then((result) => {
      settled = result;
    });

    await vi.advanceTimersByTimeAsync(4000);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toEqual({ ready: false, pending: 1 });
  });

  it("reports how many thumbs are still placeholders when the deadline hits", async () => {
    vi.useFakeTimers();
    const sheet = sheetWithThumbs([
      { kind: "img", complete: true, naturalWidth: 256 },
      { kind: "placeholder" },
      { kind: "img", complete: true, naturalWidth: 1, naturalHeight: 1 },
    ]);
    const wait = waitForSheetThumbnails(sheet, 250);
    await vi.advanceTimersByTimeAsync(400);
    await expect(wait).resolves.toEqual({ ready: false, pending: 2 });
  });
});
