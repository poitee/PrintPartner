import { useCallback } from "react";
import { useImportRulesSaveRegistry } from "../context/ImportRulesSaveContext";
import { useKitManifestSaveRegistry } from "../context/KitManifestSaveContext";

/** Await pending import-rule and kit-manifest writes before leaving Build. */
export function useFlushBuildPageSaves() {
  const { flushAll: flushImportRules } = useImportRulesSaveRegistry();
  const { flushAll: flushKitManifest } = useKitManifestSaveRegistry();

  return useCallback(async () => {
    await Promise.all([flushImportRules(), flushKitManifest()]);
  }, [flushImportRules, flushKitManifest]);
}
