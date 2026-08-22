/** Wait until sheet thumbnails finish loading (or timeout). */
export function waitForSheetThumbnails(sheet: HTMLElement, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      // Thumbs still showing the placeholder (no <img> yet) count as pending,
      // otherwise we'd resolve before eager loading has even started.
      const thumbs = sheet.querySelectorAll<HTMLElement>(".sheet-thumb");
      const pending = [...thumbs].filter((thumb) => {
        const img = thumb.querySelector<HTMLImageElement>(".sheet-thumb-img");
        return !img || !img.complete;
      });
      if (pending.length === 0 || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(check, 100);
    };

    check();
  });
}
