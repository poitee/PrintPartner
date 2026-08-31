/** Stub adapters for source kinds not yet supported in web. */

export type SourceMetadataStub = {
  supported: false;
  message: string;
  url?: string;
  title?: string | null;
};

export function fetchPrintablesMetadata(url: string): SourceMetadataStub {
  return {
    supported: false,
    message:
      "Printables is not fetched automatically in the web app. Create a Printables source with the model URL, then upload the ZIP archive you downloaded from the site.",
    url,
    title: null,
  };
}

export function fetchMakerworldMetadata(url: string): SourceMetadataStub {
  return {
    supported: false,
    message: "MakerWorld import is not supported in the web app yet. Add a GitHub or local folder source instead.",
    url,
    title: null,
  };
}

export function fetchThangsMetadata(url: string): SourceMetadataStub {
  return {
    supported: false,
    message:
      "Thangs is tracked by model URL. Download the model archive from Thangs, then upload it to refresh this source.",
    url,
    title: null,
  };
}

export function resolveRemoteSourceMetadata(
  sourceKind: string,
  url: string,
): SourceMetadataStub | null {
  if (sourceKind === "printables") return fetchPrintablesMetadata(url);
  if (sourceKind === "makerworld") return fetchMakerworldMetadata(url);
  if (sourceKind === "thangs") return fetchThangsMetadata(url);
  return null;
}
