import { useEffect, useState } from "react";
import type { ReferenceShareExport } from "@print-partner/contracts";
import { engineFetch, engineFetchStream } from "../../api/engineTransport";
import { Button } from "../ui/button";

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(URL.revokeObjectURL.bind(URL, url), 1000);
}

export default function ReferenceSharePanel({ profileId }: { profileId: number }) {
  const [exported, setExported] = useState<ReferenceShareExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [received, setReceived] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setExported(null);
    setError(null);
    void engineFetch<ReferenceShareExport>(`/plans/${profileId}/reference-share`)
      .then((result) => { if (active) setExported(result); })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Manifest could not be prepared"); });
    return () => { active = false; };
  }, [profileId]);

  async function download(kind: "manifest" | "git") {
    if (!exported) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "manifest") {
        downloadBlob(new Blob([`${JSON.stringify(exported.manifest, null, 2)}\n`], { type: "application/json" }), "printpartner.share.json");
      } else {
        const response = await engineFetchStream({
          path: "/reference-shares/git", method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(exported.manifest),
        });
        downloadBlob(await response.blob(), "printpartner-git-share.zip");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Download failed");
    } finally {
      setBusy(false);
    }
  }

  async function validate(file: File) {
    setBusy(true);
    setReceived(null);
    setError(null);
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("Manifest must be smaller than 4 MiB");
      const result = await engineFetch<ReferenceShareExport>("/reference-shares/validate", {
        method: "POST", body: await file.text(),
      });
      setReceived(`Valid ${result.manifest.kind}: ${result.manifest.title}. ${result.manifest.sources.length} source references. No files were downloaded or data changed. Build creation from this format is not available yet.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Invalid manifest");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="min-w-0 space-y-3 break-words" aria-label="References-only sharing">
      <h3 className="font-semibold">Share a recipe, not model files</h3>
      <p className="text-sm text-muted-foreground">
        Share original source links, file selections, quantities, and colors. Recipients obtain
        models from the original creators using their own access. No progress or printer settings are included.
      </p>
      {!exported && !error && <p role="status">Preparing manifest…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {exported && <>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {exported.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
        <details>
          <summary className="cursor-pointer text-sm">Preview shared manifest</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(exported.manifest, null, 2)}</pre>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void download("manifest")}>Download manifest</Button>
          <Button variant="outline" disabled={busy} onClick={() => void download("git")}>Download Git bundle</Button>
        </div>
        <p className="text-xs text-muted-foreground">Git bundle contains JSON, README, and ignore rules only. Review and commit it to your own repository. This does not push to Git.</p>
      </>}
      <details>
        <summary className="cursor-pointer text-sm">Validate a received manifest</summary>
        <label className="mt-2 block text-sm">
          Choose reference manifest JSON
          <input className="mt-1 block w-full text-sm" type="file" accept=".json,application/json" disabled={busy}
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void validate(file); event.target.value = ""; }} />
        </label>
        {received && <p role="status" className="mt-2 text-sm">{received}</p>}
      </details>
    </section>
  );
}
