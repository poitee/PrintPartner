/** Wait until sheet thumbnails finish loading a real picture (or timeout). */

export const SHEET_THUMBNAIL_WAIT_MS = 120_000;

export type SheetThumbnailWaitResult = {
  readonly ready: boolean;
  readonly pending: number;
};

export function sheetThumbnailIsReady(thumb: HTMLElement): boolean {
  const img = thumb.querySelector<HTMLImageElement>(".sheet-thumb-img");
  return Boolean(img && img.complete && img.naturalWidth > 1 && img.naturalHeight > 1);
}

export function waitForSheetThumbnails(
  sheet: HTMLElement,
  timeoutMs = SHEET_THUMBNAIL_WAIT_MS,
): Promise<SheetThumbnailWaitResult> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      const thumbs = sheet.querySelectorAll<HTMLElement>(".sheet-thumb");
      const pending = [...thumbs].filter((thumb) => !sheetThumbnailIsReady(thumb)).length;
      // Print prep remounts the sheet. Zero thumbs means the rows are not on
      // the page yet, not that every picture is loaded.
      if (thumbs.length > 0 && pending === 0) {
        resolve({ ready: true, pending: 0 });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ ready: false, pending });
        return;
      }
      setTimeout(check, 100);
    };

    check();
  });
}
