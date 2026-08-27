import { engineFetchMultipart } from "../engineTransport";

export type KitBundleUnmatchedSource = {
  name: string;
  url?: string;
  branch?: string;
  /** Git tag pin when the shared source was tag-pinned, rather than the branch tip. */
  tag?: string | null;
  source_kind?: string;
  role?: string;
  category?: string;
  import_rules?: string[];
  manifest_community_slug?: string | null;
  /** Layer slot filled by this source in the shared Plan. */
  layer_type?: string;
};

export type KitImportJobResult = {
  profile_id: number;
  profile_name: string;
  parts_imported: number;
  layers_imported: number;
  /** Legacy import result. */
  unmatched_projects?: string[];
  /** Repositories in a v3 share bundle that did not match a local Source. */
  unmatched_sources?: KitBundleUnmatchedSource[];
  warnings?: string[];
};

/** Upload a shared kit bundle and import it as a Plan. */
export async function uploadKitBundle(
  file: File,
  newName?: string,
): Promise<KitImportJobResult> {
  const form = new FormData();
  form.append("file", file);
  if (newName?.trim()) form.append("new_name", newName.trim());
  return engineFetchMultipart<KitImportJobResult>({
    path: "/imports/kit-bundle",
    form,
    failureMessage: "Import failed",
  });
}

export { uploadKitBundle as importKitBundle };
