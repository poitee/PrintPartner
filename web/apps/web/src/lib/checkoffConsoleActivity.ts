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
  verifiedLinks: PrinterCheckoffLink[];
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
  const [verifiedLinks, setVerifiedLinks] = useState<PrinterCheckoffLink[]>([]);
  const [phaseManifest, setPhaseManifest] = useState<PlanPhaseManifestResponse | null>(null);
  const [auxiliaryErrors, setAuxiliaryErrors] = useState<AuxiliaryErrors>({});
  const unattributedRequestId = useRef(0);
  const linksRequestId = useRef(0);

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
    if (!engineReady || profileId == null) return;
    const requestId = ++linksRequestId.current;
    void fetchPrinterCheckoffLinks({ profile_id: profileId })
      .then((res) => {
        if (!mounted.current || requestId !== linksRequestId.current) return;
        setWatchingLinks(res.links.filter((link) => link.state === "watching"));
        setAwaitingLinks(res.links.filter((link) => link.state === "awaiting_verify"));
        setFailedLinks(res.links.filter((link) => link.state === "host_failed"));
        setVerifiedLinks(res.links.filter((link) => link.state === "verified"));
        markSuccess("checkoff-links");
      })
      .catch((e) => {
        if (!mounted.current || requestId !== linksRequestId.current) return;
        reportError("checkoff-links", `Could not refresh printer activity: ${describe(e)}`);
      });
  }, [engineReady, markSuccess, profileId, reportError]);

  useEffect(() => {
    if (!engineReady) return;
    void refreshUnattributed();
  }, [engineReady, refreshUnattributed]);

  useEffect(() => {
    setWatchingLinks([]);
    setAwaitingLinks([]);
    setFailedLinks([]);
    setVerifiedLinks([]);
    refreshLinks();
    return () => { linksRequestId.current += 1; };
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
    verifiedLinks,
    phaseManifest,
    auxiliaryError: currentAuxiliaryError(auxiliaryErrors),
    refreshUnattributed,
    refreshLinks,
    reportError,
    markSuccess,
  };
}
