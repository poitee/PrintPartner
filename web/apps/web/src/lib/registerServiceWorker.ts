/**
 * Register the navigation-only service worker. updateViaCache is disabled so
 * cache-safety fixes reach browsers even when an intermediary cached sw.js.
 *
 * Call once at app startup (main.tsx).
 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        console.debug("[PWA] Service worker registered", reg.scope);
        void reg.update().catch((err: unknown) => {
          console.warn("[PWA] Service worker update check failed", err);
        });
      })
      .catch((err) => {
        console.warn("[PWA] Service worker registration failed", err);
      });

  });
}
