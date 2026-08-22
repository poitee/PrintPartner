/**
 * registerServiceWorker — registers /sw.js and wires up sync-complete
 * messages so open windows can refetch after coming back online.
 *
 * Call once at app startup (main.tsx).
 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        console.debug("[PWA] Service worker registered", reg.scope);
      })
      .catch((err) => {
        console.warn("[PWA] Service worker registration failed", err);
      });

    // Listen for sync-complete messages from the SW and dispatch a custom
    // DOM event that React Query listeners can subscribe to.
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "PP_SYNC_COMPLETE") {
        window.dispatchEvent(new CustomEvent("pp:sync-complete"));
      }
    });
  });
}
