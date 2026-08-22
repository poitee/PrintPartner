/**
 * Print Partner service worker
 *
 * Strategy:
 *   - App shell (HTML + JS/CSS assets) → Cache-First (versioned cache)
 *   - Parts list & checkoff GET responses → Network-First with cache fallback
 *   - Checkoff PATCH/POST mutations → Background Sync queue when offline
 *
 * Cache names embed a version string so old caches are purged on activate.
 */

const SW_VERSION = "v2";
const SHELL_CACHE = `pp-shell-${SW_VERSION}`;
const DATA_CACHE  = `pp-data-${SW_VERSION}`;
const SYNC_TAG    = "pp-checkoff-sync";

// ── URLs to pre-cache (app shell) ───────────────────────────────────────────
const SHELL_URLS = ["/", "/progress", "/offline.html"];

// ── Install: pre-cache app shell ─────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_URLS).catch(() => {
        // Non-fatal: offline.html may not exist yet; ignore individual failures
      })
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: remove stale caches ────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: routing logic ──────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin requests
  if (url.origin !== self.location.origin) return;

  // Mutation requests (checkoff toggle / reconcile) → queue when offline
  if (isMutation(request)) {
    event.respondWith(networkWithQueueFallback(request));
    return;
  }

  // Cache API match/put only accepts GET requests. Let all other mutations
  // proceed directly to the network unless they use the checkoff sync queue.
  if (request.method !== "GET") return;

  // Parts list & checkoff GET data → network-first, cache fallback
  if (isDataEndpoint(url.pathname)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Everything else (assets, shell HTML) → cache-first
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

// ── Background Sync ──────────────────────────────────────────────────────────
self.addEventListener("sync", (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(flushQueue());
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMutation(request) {
  return (
    (request.method === "PATCH" ||
      request.method === "POST" ||
      request.method === "PUT") &&
    isCheckoffPath(new URL(request.url).pathname)
  );
}

function isCheckoffPath(pathname) {
  return (
    pathname.startsWith("/printer-checkoff") ||
    pathname.startsWith("/plans/") && pathname.includes("/checkoff")
  );
}

function isDataEndpoint(pathname) {
  return (
    pathname.startsWith("/printer-checkoff") ||
    pathname.startsWith("/parts") ||
    pathname.startsWith("/plans/")
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function networkWithQueueFallback(request) {
  try {
    return await fetch(request);
  } catch {
    await enqueue(request);
    // Register background sync if the API exists
    if (self.registration.sync) {
      await self.registration.sync.register(SYNC_TAG);
    }
    return new Response(
      JSON.stringify({ queued: true, message: "Checkoff queued for sync" }),
      {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// ── Queue storage (IndexedDB-lite via Cache API workaround) ──────────────────
// We store queued requests as serialised JSON blobs in a dedicated cache key.
const QUEUE_CACHE = "pp-sync-queue";

async function enqueue(request) {
  const body = await request.text().catch(() => "");
  const entry = {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body,
    timestamp: Date.now(),
  };
  const cache = await caches.open(QUEUE_CACHE);
  const existing = await cache.match("queue");
  const queue = existing ? await existing.json().catch(() => []) : [];
  queue.push(entry);
  await cache.put(
    "queue",
    new Response(JSON.stringify(queue), {
      headers: { "Content-Type": "application/json" },
    })
  );
}

async function flushQueue() {
  const cache = await caches.open(QUEUE_CACHE);
  const stored = await cache.match("queue");
  if (!stored) return;
  const queue = await stored.json().catch(() => []);
  const remaining = [];
  for (const entry of queue) {
    try {
      const res = await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body || undefined,
      });
      if (!res.ok) remaining.push(entry); // keep on server error; retry later
    } catch {
      remaining.push(entry); // still offline
    }
  }
  if (remaining.length === 0) {
    await cache.delete("queue");
  } else {
    await cache.put(
      "queue",
      new Response(JSON.stringify(remaining), {
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  // Notify open windows to refetch parts data
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({ type: "PP_SYNC_COMPLETE" });
  }
}
