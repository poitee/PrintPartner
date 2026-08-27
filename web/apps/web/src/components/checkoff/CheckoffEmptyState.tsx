import { ClipboardCheck } from "lucide-react";
import type { CheckoffViewId } from "../../lib/checkoffConsoleModel";
import EmptyState from "../layout/EmptyState";

type Props = {
  planSelected: boolean;
  hasParts: boolean;
  searching: boolean;
  view: CheckoffViewId;
  onOpenPlan: () => void;
  onClearSearch: () => void;
  onSelectView: (view: CheckoffViewId) => void;
};

/**
 * Empty views still name an owner and a route. "Nothing here" is never the
 * whole message on a shop-floor screen.
 */
export default function CheckoffEmptyState({
  planSelected,
  hasParts,
  searching,
  view,
  onOpenPlan,
  onClearSearch,
  onSelectView,
}: Props) {
  if (!planSelected) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No Build selected"
        description="Pick a Build to track remaining print work."
        action={{ label: "Open Plan", onClick: onOpenPlan }}
      />
    );
  }
  if (!hasParts) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No parts yet"
        description="Pick a Build, then track remaining on Checkoff."
        action={{ label: "Open Plan", onClick: onOpenPlan }}
      />
    );
  }
  if (searching) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No parts match"
        description="Clear the search to see the rest of this view."
        action={{ label: "Clear search", onClick: onClearSearch }}
      />
    );
  }
  if (view === "remaining") {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Nothing left to print"
        description="Every Required unit is verified."
        action={{ label: "See completed units", onClick: () => onSelectView("completed") }}
      />
    );
  }
  return (
    <EmptyState
      icon={ClipboardCheck}
      title="Nothing verified yet"
      description="Verified units appear here with their assembly state."
      action={{ label: "Open the worklist", onClick: () => onSelectView("remaining") }}
    />
  );
}
