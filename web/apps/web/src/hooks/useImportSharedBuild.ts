import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { importKitBundle, pickKitBundle } from "../api/engine";
import { useProfileSelection } from "../context/ProfileContext";
import { buildRoute } from "../lib/routes";
import { stashKitImportResult } from "../lib/kitImportStash";

/** Pick a .print-partner-kit.zip and import it as a new plan. */
export function useImportSharedBuild() {
  const navigate = useNavigate();
  const { setSelectedProfileId, reloadProfiles } = useProfileSelection();

  return useCallback(async () => {
    const picked = await pickKitBundle();
    if (!picked) {
      toast.message("Import cancelled");
      return;
    }
    try {
      const result = await importKitBundle(picked);
      if (!result.profile_id) {
        toast.error("Import did not create a plan");
        return;
      }
      stashKitImportResult(result);
      setSelectedProfileId(result.profile_id);
      navigate(buildRoute(result.profile_id), {
        replace: true,
        state: { kitImport: result },
      });
      void reloadProfiles();
      toast.success(`Imported “${result.profile_name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [navigate, reloadProfiles, setSelectedProfileId]);
}
