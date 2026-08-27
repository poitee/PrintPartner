import {
  pickKitBundleFileWeb,
  pickLocalDirectoryWeb,
  pickLocalFilesWeb,
  pickZipArchiveFileWeb,
  saveTextFileWeb,
} from "@/lib/webFilePickers";
import { resolveEngineUrl } from "../contractRequest";

/** Pick a kit bundle file in the browser. */
export async function pickKitBundle(): Promise<File | null> {
  return pickKitBundleFileWeb();
}

export async function pickLocalDirectory(): Promise<File[]> {
  return pickLocalDirectoryWeb();
}

export async function pickLocalFiles(): Promise<File[]> {
  return pickLocalFilesWeb();
}

export async function saveTextFile(
  defaultName: string,
  contents: string,
): Promise<string | null> {
  return saveTextFileWeb(defaultName, contents);
}

/**
 * Absolute URL for a server-served asset path returned by a job result.
 * Unlike {@link downloadExport}, this returns a value suitable for `<img src>`.
 */
export function engineAssetUrl(path: string): string {
  return /^https?:\/\//i.test(path) ? path : resolveEngineUrl(path);
}

/**
 * Trigger a browser download for a server-produced export. `downloadUrl` is the
 * `download_url` returned by export jobs (e.g. "/exports/<key>"); the server
 * serves it with Content-Disposition: attachment.
 */
export function downloadExport(downloadUrl: string, suggestedName?: string): void {
  if (typeof document === "undefined") return;
  const href = /^https?:\/\//i.test(downloadUrl) ? downloadUrl : resolveEngineUrl(downloadUrl);
  const anchor = document.createElement("a");
  anchor.href = href;
  if (suggestedName) anchor.download = suggestedName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function pickZipArchive(): Promise<File | null> {
  return pickZipArchiveFileWeb();
}
