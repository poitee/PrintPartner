import type { ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_TARGET = process.env.VITE_DEV_API_TARGET ?? "http://127.0.0.1:18765";
const SOURCE_DIR = fileURLToPath(new URL("./src", import.meta.url));

/** Backend route prefixes proxied to the Fastify server during `npm run dev`. */
const API_PREFIXES = [
  "api/v1",
  "api",
  "admin",
  "assistant",
  "backups",
  "exports",
  "health",
  "mcp",
  "metrics",
  "plans",
  "profile-library",
  "sources",
  "jobs",
  "parts",
  "printers",
  "printer-presets",
  "slicer-profile-options",
  "slicer-instances",
  "slicer-handoff",
  "settings",
  "filaments",
  "integrations",
  "printer-checkoff",
  "printer-outcomes",
  "printer-send-queue",
  "bambu-connect",
  "legal",
  "help",
  "auth",
  "shares",
  "kit-catalog",
  "manifest-registry",
  "manifest-templates",
  "community",
  "imports",
  "ws",
];

/**
 * Exact SPA routes whose path is also an API prefix. `/sources` and `/printers`
 * even answer a same-path GET, so a plain bypass would break the client while a
 * plain proxy hands the browser raw JSON instead of the app.
 *
 * One rule covers both cases: bypass browser document navigations, proxy
 * everything else. `fetch` sends `Accept: *\/*` unless the caller says
 * otherwise, so API calls keep reaching the server.
 *
 * Keep this in sync with SPA_PATHS in
 * `apps/server/src/lib/spa-nav.ts`, which does the same job in production.
 */
const SPA_EXACT_PATHS = new Set([
  "/help",
  "/parts",
  "/plans",
  "/printers",
  "/settings",
  "/sources",
]);

function isDocumentNavigation(req: IncomingMessage): boolean {
  const mode = req.headers["sec-fetch-mode"];
  if (mode === "navigate") return true;
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/html") && !accept.includes("application/json");
}

function spaExactBypass(req: IncomingMessage): string | undefined {
  const raw = req.url ?? "";
  let pathname = raw.split("?", 1)[0] ?? "";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  if (SPA_EXACT_PATHS.has(pathname) && isDocumentNavigation(req)) return raw;
  return undefined;
}

const proxy: Record<string, ProxyOptions> = Object.fromEntries(
  API_PREFIXES.map((prefix) => {
    const options: ProxyOptions = {
      target: API_TARGET,
      changeOrigin: true,
      ws: prefix === "ws" || prefix === "jobs",
    };
    const exact = `/${prefix}`;
    if (SPA_EXACT_PATHS.has(exact)) {
      options.bypass = spaExactBypass;
    }
    return [`/${prefix}`, options];
  }),
);

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(SOURCE_DIR),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
  envPrefix: ["VITE_"],
  build: {
    target: "es2022",
    outDir: "dist",
    // Three.js is lazy-loaded and compresses to ~132 kB, but its single module
    // is just over Vite's 500 kB raw warning threshold.
    chunkSizeWarningLimit: 550,
  },
});
