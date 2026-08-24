/**
 * Print Partner service worker.
 *
 * Authenticated API responses and queued mutations are deliberately excluded
 * from Cache Storage because the browser can outlive or switch user sessions.
 * The worker provides only an offline fallback for top-level navigation.
 */

const SW_VERSION = "v3";
const OFFLINE_CACHE = `pp-offline-${SW_VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL]))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(isLegacyPrintPartnerCache)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.mode !== "navigate") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(navigateWithOfflineFallback(request));
});

function isLegacyPrintPartnerCache(key) {
  if (key === OFFLINE_CACHE) return false;
  return (
    key.startsWith("pp-shell-") ||
    key.startsWith("pp-data-") ||
    key.startsWith("pp-offline-") ||
    key === "pp-sync-queue"
  );
}

async function navigateWithOfflineFallback(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(OFFLINE_CACHE);
    const offline = await cache.match(OFFLINE_URL);
    return offline ?? new Response("Offline", { status: 503 });
  }
}
