/** Stub adapters for source kinds not yet supported in web. */

type SourceMetadataStub = {
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
