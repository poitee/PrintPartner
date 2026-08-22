import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { platform } from "node:os";

const CONNECT_VERSION = "1.0.0";

const ALLOWED_EXT = [".gcode.3mf", ".3mf", ".gcode", ".gco"] as const;

export function sanitizeBambuConnectFilename(filename: string): string {
  const base = basename(filename.replace(/\\/g, "/")).trim() || "print.3mf";
  // eslint-disable-next-line no-control-regex -- strip NUL/C0 controls from upload names
  const cleaned = base.replace(/[/\\]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || /^\.+$/.test(cleaned)) {
    return "print.3mf";
  }
  return cleaned;
}

export function isAllowedBambuConnectFilename(filename: string): boolean {
  const lower = sanitizeBambuConnectFilename(filename).toLowerCase();
  return ALLOWED_EXT.some((ext) => lower.endsWith(ext));
}

/** Display name for Connect (basename without extension). */
export function bambuConnectDisplayName(filename: string): string {
  const base = sanitizeBambuConnectFilename(filename);
  const lower = base.toLowerCase();
  for (const ext of ALLOWED_EXT) {
    if (lower.endsWith(ext)) return base.slice(0, -ext.length) || "print";
  }
  return base.replace(/\.[^.]+$/, "") || "print";
}

/**
 * Official Bambu Connect third-party import URL scheme.
 * @see https://wiki.bambulab.com/en/software/bambu-connect
 */
export function buildBambuConnectUrl(absolutePath: string, displayName: string): string {
  const path = absolutePath.trim();
  const name = displayName.trim() || "print";
  if (!path) throw new Error("absolute path is required");
  const qs = new URLSearchParams({
    path,
    name,
    version: CONNECT_VERSION,
  });
  // URLSearchParams encodes for application/x-www-form-urlencoded; Connect wants
  // encodeURIComponent-style path/name. Both are fine for path segments.
  return `bambu-connect://import-file?${qs.toString()}`;
}

/** True when the API likely runs inside a container (Connect cannot see container paths). */
export function isLikelyContainerRuntime(): boolean {
  if (process.env.PRINT_PARTNER_IN_CONTAINER === "1") return true;
  if (process.env.PRINT_PARTNER_IN_CONTAINER === "0") return false;
  return existsSync("/.dockerenv");
}

/**
 * Map a container absolute path to a host path when BAMBU_CONNECT_HOST_PATH_MAP
 * is set as `containerPrefix=hostPrefix` (e.g. `/data=/Users/me/pp-data`).
 */
export function resolveBambuConnectHostPath(absolutePath: string): string {
  const raw = process.env.BAMBU_CONNECT_HOST_PATH_MAP?.trim();
  if (!raw) return absolutePath;
  const eq = raw.indexOf("=");
  if (eq <= 0) return absolutePath;
  let from = raw.slice(0, eq);
  let to = raw.slice(eq + 1);
  if (!from) return absolutePath;
  // Normalize trailing separators so `/data/` and `/data` behave the same.
  while (from.length > 1 && from.endsWith("/")) from = from.slice(0, -1);
  while (to.length > 1 && to.endsWith("/")) to = to.slice(0, -1);
  if (absolutePath !== from && !absolutePath.startsWith(`${from}/`)) {
    return absolutePath;
  }
  return `${to}${absolutePath.slice(from.length)}`;
}

function envLaunchPreference(): "auto" | "force" | "off" {
  const raw = (process.env.BAMBU_CONNECT_LAUNCH ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return "off";
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return "force";
  return "auto";
}

export function shouldAttemptBambuConnectLaunch(options?: {
  requestLaunch?: boolean;
}): boolean {
  const pref = envLaunchPreference();
  if (pref === "off") return false;
  if (options?.requestLaunch === false) return false;
  if (pref === "force") return true;
  if (isLikelyContainerRuntime()) return false;
  const p = platform();
  return p === "darwin" || p === "win32" || p === "linux";
}

/** Resolve OS launcher for a bambu-connect:// URL (exported for tests). */
export function bambuConnectLaunchCommand(
  url: string,
  osPlatform: NodeJS.Platform = platform(),
): { cmd: string; args: string[] } {
  if (osPlatform === "darwin") return { cmd: "open", args: [url] };
  if (osPlatform === "win32") {
    // rundll32 preserves query `&` — `cmd /c start` would split on `&`.
    return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { cmd: "xdg-open", args: [url] };
}

/**
 * Open the Connect URL scheme on the host OS (desk self-host).
 * Does not reverse-engineer MQTT print-start.
 */
export function tryLaunchBambuConnectUrl(
  url: string,
): Promise<{ launched: boolean; error?: string }> {
  return new Promise((resolve) => {
    const { cmd, args } = bambuConnectLaunchCommand(url);
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.unref();
      child.on("error", (err) => {
        resolve({ launched: false, error: err.message || String(err) });
      });
      // Prefer "attempted" success — Connect may still fail to handle the URL.
      setTimeout(() => resolve({ launched: true }), 50);
    } catch (e) {
      resolve({
        launched: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}
