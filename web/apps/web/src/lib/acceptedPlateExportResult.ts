import {
  parseAcceptedPlateExportJobResult,
  type AcceptedPlateExportJobResult,
  type JobSnapshot,
} from "@print-partner/contracts";

type DownloadAnchor = {
    href: string;
    download: string;
    click: () => void;
    remove: () => void;
};

type DownloadDocument = Readonly<{
  createElement: (tag: "a") => DownloadAnchor;
  body: Readonly<{ append: (element: DownloadAnchor) => void }>;
}>;

type DownloadResult =
  | { readonly kind: "downloaded"; readonly result: AcceptedPlateExportJobResult }
  | { readonly kind: "job_failed" }
  | { readonly kind: "invalid_result" };

export function downloadAcceptedPlateExport(
  snapshot: JobSnapshot,
  targetDocument?: DownloadDocument,
): DownloadResult {
  if (snapshot.status !== "done" || snapshot.result === null) return { kind: "job_failed" };
  let result: AcceptedPlateExportJobResult;
  try {
    result = parseAcceptedPlateExportJobResult(snapshot.result);
  } catch {
    return { kind: "invalid_result" };
  }
  if (!targetDocument) {
    const anchor = document.createElement("a");
    anchor.href = result.download_url;
    anchor.download = "";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return { kind: "downloaded", result };
  }
  const anchor = targetDocument.createElement("a");
  anchor.href = result.download_url;
  anchor.download = "";
  targetDocument.body.append(anchor);
  anchor.click();
  anchor.remove();
  return { kind: "downloaded", result };
}
