/**
 * Printer activity behind the Checkoff console.
 *
 * Checkoff reads four related records: prints a host finished and nobody has
 * verified, jobs that failed, jobs still running, and printer activity that
 * matched no Build. They refresh together, and a refresh failure becomes a
 * named auxiliary error instead of a vanishing toast.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { UnattributedPrint } from "@print-partner/contracts";
import {
  fetchPrinterCheckoffLinks,
  fetchUnattributedPrints,
  type PrinterCheckoffLink,
} from "../api/endpoints/checkoff";
import {
  fetchPlanPhaseManifest,
  type PlanPhaseManifestResponse,
} from "../api/endpoints/planVariants";
import {
  clearAuxiliaryError,
  currentAuxiliaryError,
  setAuxiliaryError,
  type AuxiliaryErrors,
} from "./auxiliaryErrors";

export type CheckoffPrinterActivity = {
  unattributedPrints: UnattributedPrint[];
  watchingLinks: PrinterCheckoffLink[];
  awaitingLinks: PrinterCheckoffLink[];
  failedLinks: PrinterCheckoffLink[];
  phaseManifest: PlanPhaseManifestResponse | null;
  auxiliaryError: string | null;
  refreshUnattributed: () => Promise<void>;
  refreshLinks: () => void;
  reportError: (key: string, message: string) => void;
  markSuccess: (key: string) => void;
};

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useCheckoffPrinterActivity(input: {
  engineReady: boolean;
  profileId: number | null;
  /** Extra keys the page reports on, so one banner covers every background read. */
  externalError?: { key: string; message: string | null };
}): CheckoffPrinterActivity {
  const { engineReady, profileId, externalError } = input;
  const [unattributedPrints, setUnattributedPrints] = useState<UnattributedPrint[]>([]);
  const [watchingLinks, setWatchingLinks] = useState<PrinterCheckoffLink[]>([]);
  const [awaitingLinks, setAwaitingLinks] = useState<PrinterCheckoffLink[]>([]);
  const [failedLinks, setFailedLinks] = useState<PrinterCheckoffLink[]>([]);
  const [phaseManifest, setPhaseManifest] = useState<PlanPhaseManifestResponse | null>(null);
  const [auxiliaryErrors, setAuxiliaryErrors] = useState<AuxiliaryErrors>({});
  const unattributedRequestId = useRef(0);

  /**
   * These reads outlive the component when the operator leaves Checkoff while a
   * printer poll is still open. Without this guard the late resolution calls
   * setState on an unmounted tree, which React discards in the browser but which
   * throws in a torn-down test environment.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reportError = useCallback((key: string, message: string) => {
    if (!mounted.current) return;
    setAuxiliaryErrors((errors) => setAuxiliaryError(errors, key, message));
  }, []);
  const markSuccess = useCallback((key: string) => {
    if (!mounted.current) return;
    setAuxiliaryErrors((errors) => clearAuxiliaryError(errors, key));
  }, []);

  const refreshUnattributed = useCallback(async () => {
    const requestId = ++unattributedRequestId.current;
    try {
      const prints = await fetchUnattributedPrints();
      if (!mounted.current || requestId !== unattributedRequestId.current) return;
      setUnattributedPrints(prints);
      markSuccess("printer-activity");
    } catch (e) {
      if (!mounted.current || requestId !== unattributedRequestId.current) return;
      reportError("printer-activity", `Could not refresh printer activity: ${describe(e)}`);
    }
  }, [markSuccess, reportError]);

  const refreshLinks = useCallback(() => {
    if (!engineReady) return;
    const read = (
      state: "watching" | "awaiting_verify" | "host_failed",
      key: string,
      apply: (links: PrinterCheckoffLink[]) => void,
    ) => {
      void fetchPrinterCheckoffLinks({ state, profile_id: profileId ?? undefined })
        .then((res) => {
          if (!mounted.current) return;
          apply(res.links ?? []);
          markSuccess(key);
        })
        .catch((e) =>
          reportError(key, `Could not refresh printer activity: ${describe(e)}`),
        );
    };
    read("watching", "watching-links", setWatchingLinks);
    read("awaiting_verify", "awaiting-links", setAwaitingLinks);
    read("host_failed", "failed-links", setFailedLinks);
  }, [engineReady, markSuccess, profileId, reportError]);

  useEffect(() => {
    if (!engineReady) return;
    void refreshUnattributed();
  }, [engineReady, refreshUnattributed]);

  useEffect(() => {
    refreshLinks();
  }, [refreshLinks]);

  useEffect(() => {
    if (!engineReady || profileId == null) {
      setPhaseManifest(null);
      return;
    }
    void fetchPlanPhaseManifest(profileId)
      .then((manifest) => {
        if (!mounted.current) return;
        setPhaseManifest(manifest);
        markSuccess("phase-progress");
      })
      .catch((e) =>
        reportError("phase-progress", `Could not load phase progress: ${describe(e)}`),
      );
  }, [engineReady, markSuccess, profileId, reportError]);

  useEffect(() => {
    if (!externalError) return;
    if (externalError.message) reportError(externalError.key, externalError.message);
    else markSuccess(externalError.key);
  }, [externalError, markSuccess, reportError]);

  useEffect(() => {
    setAuxiliaryErrors({});
  }, [profileId]);

  return {
    unattributedPrints,
    watchingLinks,
    awaitingLinks,
    failedLinks,
    phaseManifest,
    auxiliaryError: currentAuxiliaryError(auxiliaryErrors),
    refreshUnattributed,
    refreshLinks,
    reportError,
    markSuccess,
  };
}
