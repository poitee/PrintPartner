import { ClipboardCheck } from "lucide-react";
import type { ProfileSummary, UnattributedPrint } from "@print-partner/contracts";
import type { PrinterCheckoffLink } from "../../api/endpoints/checkoff";
import type { ReviewPart } from "../../api/endpoints/planManifests";
import type { CheckoffAttentionItem } from "../../lib/checkoffConsoleModel";
import EmptyState from "../layout/EmptyState";
import CheckoffAttentionSummary from "./CheckoffAttentionSummary";
import PrintVerifyPanel, { type PrintVerifyQueueState } from "./PrintVerifyPanel";
import UnattributedPrintCard from "./UnattributedPrintCard";

type Props = {
  items: CheckoffAttentionItem[];
  engineReady: boolean;
  profileId: number;
  parts: ReviewPart[];
  refreshKey: number;
  links: {
    watching: PrinterCheckoffLink[];
    awaiting: PrinterCheckoffLink[];
    failed: PrinterCheckoffLink[];
  };
  unattributedPrints: UnattributedPrint[];
  profiles: readonly Pick<ProfileSummary, "id" | "name">[];
  suppressIntegrationIds: ReadonlySet<string>;
  onActivityRefresh: () => void;
  onQueueChange: (state: PrintVerifyQueueState) => void;
  onVerified: () => void;
  onClaimed: () => void;
  onDismissed: () => void;
  onOpenWorklist: () => void;
};

/**
 * Needs attention: the first view, and the one that owns the primary action.
 *
 * The summary says what is waiting. The verify panel resolves it. Confirm is
 * still a human decision — a successful host status never marks a unit
 * printed on its own.
 */
export default function CheckoffAttentionView({
  items,
  engineReady,
  profileId,
  parts,
  refreshKey,
  links,
  unattributedPrints,
  profiles,
  suppressIntegrationIds,
  onActivityRefresh,
  onQueueChange,
  onVerified,
  onClaimed,
  onDismissed,
  onOpenWorklist,
}: Props) {
  return (
    <div className="no-print flex flex-col gap-3">
      <CheckoffAttentionSummary items={items} />
      <PrintVerifyPanel
        engineReady={engineReady}
        profileId={profileId}
        parts={parts}
        refreshKey={refreshKey}
        activityLinks={links}
        onActivityRefresh={onActivityRefresh}
        suppressIntegrationIds={suppressIntegrationIds}
        onQueueChange={onQueueChange}
        onVerified={onVerified}
      />
      {unattributedPrints.map((print) => (
        <UnattributedPrintCard
          key={print.id}
          print={print}
          profiles={profiles}
          onClaimed={onClaimed}
          onDismissed={onDismissed}
        />
      ))}
      {items.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="Nothing needs verification"
          description="Finished printer jobs, failed jobs, and unmatched printer activity land here."
          action={{ label: "Open the worklist", onClick: onOpenWorklist }}
        />
      ) : null}
    </div>
  );
}
