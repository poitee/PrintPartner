/**
 * Google Drive open/save for parts manifests via Google Identity Services (token
 * client) + Drive REST. Requires a public OAuth Web client id — never a secret.
 *
 * Configure either:
 *   GOOGLE_CLIENT_ID on the API (exposed via GET /health → google_drive.client_id)
 *   or VITE_GOOGLE_CLIENT_ID at SPA build time (dev fallback)
 *
 * Create an OAuth 2.0 Web client in Google Cloud Console, enable the Google Drive
 * API, and add your app origin to Authorized JavaScript origins. Scope used:
 * drive.file (only files the app creates/opens).
 */

const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const GIS_LOAD_TIMEOUT_MS = 15_000;
/** Marks a GIS <script> that already fired its (one-shot) load event. */
const GIS_LOADED_ATTR = "data-pp-gis-loaded";
/** Brief poll window for a script that loaded but hasn't attached oauth2 yet. */
const GIS_LATE_POLL_MS = 200;
const GIS_LATE_POLL_ATTEMPTS = 10;

type TokenClient = {
  requestAccessToken: (opts?: { prompt?: string }) => void;
};

type GisWindow = Window & {
  google?: {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: {
          client_id: string;
          scope: string;
          callback: (resp: { access_token?: string; error?: string }) => void;
          error_callback?: (err: { type?: string; message?: string }) => void;
        }) => TokenClient;
      };
    };
  };
};

let gisLoad: Promise<void> | null = null;
let cachedToken: { token: string; expiresAt: number } | null = null;

export function clearGoogleDriveTokenCache(): void {
  cachedToken = null;
}

function isTokenRelated403(detail: string): boolean {
  const d = detail.toLowerCase();
  return (
    d.includes("autherror") ||
    d.includes("invalid_token") ||
    d.includes("invalid credentials") ||
    d.includes("login required") ||
    d.includes("access_token") ||
    d.includes("expired")
  );
}

async function throwDriveHttpError(action: string, res: Response): Promise<never> {
  const detail = await res.text().catch(() => "");
  if (res.status === 401 || (res.status === 403 && isTokenRelated403(detail))) {
    clearGoogleDriveTokenCache();
  }
  throw new Error(`Drive ${action} failed (${res.status}): ${detail.slice(0, 200)}`);
}

function loadGis(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  const w = window as GisWindow;
  if (w.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoad) return gisLoad;
  gisLoad = new Promise((resolve, reject) => {
    let settled = false;
    /** Script this attempt is waiting on; removed on failure so retries can recreate. */
    let watchedScript: HTMLScriptElement | null = null;
    let pollTimer: number | null = null;
    const reset = () => {
      watchedScript?.remove();
      gisLoad = null;
      if (pollTimer != null) window.clearInterval(pollTimer);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      if (pollTimer != null) window.clearInterval(pollTimer);
      fn();
    };
    const succeed = () => {
      finish(() => {
        if (w.google?.accounts?.oauth2) {
          resolve();
        } else {
          reset();
          reject(new Error("Google Identity Services unavailable"));
        }
      });
    };
    const fail = (err: Error) => {
      finish(() => {
        reset();
        reject(err);
      });
    };
    const timeoutId = window.setTimeout(() => {
      fail(new Error("Timed out loading Google Identity"));
    }, GIS_LOAD_TIMEOUT_MS);

    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing instanceof HTMLScriptElement) {
      if (w.google?.accounts?.oauth2) {
        succeed();
        return;
      }
      watchedScript = existing;
      if (existing.getAttribute(GIS_LOADED_ATTR) === "1") {
        // This script's 'load' event already fired once (it won't fire again) but
        // oauth2 still isn't attached — poll briefly instead of hanging until the
        // full timeout, then fail fast so the caller can retry.
        let attempts = 0;
        pollTimer = window.setInterval(() => {
          attempts += 1;
          if (w.google?.accounts?.oauth2) {
            succeed();
          } else if (attempts >= GIS_LATE_POLL_ATTEMPTS) {
            fail(new Error("Google Identity Services unavailable after load"));
          }
        }, GIS_LATE_POLL_MS);
        return;
      }
      existing.addEventListener("load", () => {
        existing.setAttribute(GIS_LOADED_ATTR, "1");
        succeed();
      });
      existing.addEventListener("error", () => fail(new Error("Failed to load Google Identity")));
      return;
    }
    const script = document.createElement("script");
    watchedScript = script;
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => {
      script.setAttribute(GIS_LOADED_ATTR, "1");
      succeed();
    };
    script.onerror = () => fail(new Error("Failed to load Google Identity"));
    document.head.appendChild(script);
  });
  return gisLoad;
}

export function resolveGoogleClientId(healthClientId?: string | null): string | null {
  const fromHealth = healthClientId?.trim() || null;
  if (fromHealth) return fromHealth;
  const fromVite = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || null;
  return fromVite;
}

export async function requestGoogleDriveToken(clientId: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  await loadGis();
  const w = window as GisWindow;
  if (!w.google?.accounts?.oauth2) {
    throw new Error("Google Identity Services unavailable");
  }
  return new Promise((resolve, reject) => {
    const client = w.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error || "Google authorization failed"));
          return;
        }
        cachedToken = {
          token: resp.access_token,
          // GIS tokens are typically ~1h; we don't get expires_in on all paths
          expiresAt: Date.now() + 50 * 60 * 1000,
        };
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        reject(new Error(err.message || err.type || "Google authorization failed"));
      },
    });
    client.requestAccessToken({ prompt: "" });
  });
}

export type DriveFileRef = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
};

export async function uploadBlobToGoogleDrive(
  accessToken: string,
  blob: Blob,
  filename: string,
  mimeType: string,
): Promise<DriveFileRef> {
  const meta = {
    name: filename,
    mimeType,
  };
  const boundary =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `pp_${crypto.randomUUID()}`
      : `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  const metaPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(meta)}\r\n`;
  const fileHeader =
    `--${boundary}\r\n` + `Content-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;

  const body = new Blob([metaPart, fileHeader, blob, footer], {
    type: `multipart/related; boundary=${boundary}`,
  });

  const res = await fetch(DRIVE_UPLOAD, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body,
  });
  if (!res.ok) {
    await throwDriveHttpError("upload", res);
  }
  const json = (await res.json()) as { id: string; name: string; mimeType?: string };
  return { id: json.id, name: json.name, mimeType: json.mimeType || mimeType };
}

export async function listGoogleDriveManifestFiles(
  accessToken: string,
): Promise<DriveFileRef[]> {
  const q = encodeURIComponent(
    "(mimeType='text/csv' or mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType='application/vnd.google-apps.spreadsheet' or name contains '_parts_manifest') and trashed=false",
  );
  const fields = encodeURIComponent("files(id,name,mimeType,modifiedTime)");
  const res = await fetch(`${DRIVE_FILES}?q=${q}&pageSize=25&fields=${fields}&orderBy=modifiedTime desc`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    await throwDriveHttpError("list", res);
  }
  const json = (await res.json()) as { files?: DriveFileRef[] };
  return json.files ?? [];
}

export async function downloadGoogleDriveFile(
  accessToken: string,
  file: DriveFileRef,
): Promise<{ bytes: ArrayBuffer; name: string; kind: "csv" | "xlsx" }> {
  const isGoogleSheet = file.mimeType === "application/vnd.google-apps.spreadsheet";
  const url = isGoogleSheet
    ? `${DRIVE_FILES}/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent("text/csv")}`
    : `${DRIVE_FILES}/${encodeURIComponent(file.id)}?alt=media`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    await throwDriveHttpError("download", res);
  }
  const bytes = await res.arrayBuffer();
  const lower = file.name.toLowerCase();
  const kind: "csv" | "xlsx" =
    isGoogleSheet || lower.endsWith(".csv") || file.mimeType === "text/csv" ? "csv" : "xlsx";
  const name = isGoogleSheet && !lower.endsWith(".csv") ? `${file.name}.csv` : file.name;
  return { bytes, name, kind };
}
