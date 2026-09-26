import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { pickKitBundle } from "../api/endpoints/browserFiles";
import { uploadKitBundle } from "../api/endpoints/imports";
import { useProfileSelection } from "../context/ProfileContext";
import { buildRoute, isPlanPath, isSourcesPath } from "../lib/routes";
import { stashKitImportResult } from "../lib/kitImportStash";
import { useFlushBuildPageSaves } from "./useFlushBuildPageSaves";

/** Pick a .print-partner-kit.zip and import it as a new plan. */
export function useImportSharedBuild() {
  const navigate = useNavigate();
  const location = useLocation();
  const flushSaves = useFlushBuildPageSaves();
  const { reloadProfiles, setSelectedProfileId } = useProfileSelection();

  return useCallback(async () => {
    const picked = await pickKitBundle();
    if (!picked) {
      toast.message("Import cancelled");
      return;
    }
    try {
      if (isSourcesPath(location.pathname) || isPlanPath(location.pathname)) {
        await flushSaves();
      }
      const result = await uploadKitBundle(picked);
      if (!result.profile_id) {
        toast.error("Import did not create a plan");
        return;
      }
      stashKitImportResult(result);
      let profilesReloaded = true;
      try {
        await reloadProfiles({ throwOnError: true });
      } catch {
        profilesReloaded = false;
        setSelectedProfileId(result.profile_id);
        toast.error(`Imported “${result.profile_name}”, but the Build list could not refresh. Refresh if it does not appear.`);
      }
      navigate(buildRoute(result.profile_id), {
        replace: true,
        state: { kitImport: result },
      });
      if (profilesReloaded) toast.success(`Imported “${result.profile_name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [flushSaves, location.pathname, navigate, reloadProfiles, setSelectedProfileId]);
}
