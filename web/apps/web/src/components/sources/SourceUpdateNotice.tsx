import { Bell, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useState } from "react";
import type { SourceActivityEvent } from "../../api/endpoints/sourceContent";
import { useSourceMonitoringQueries } from "../../queries/sourceMonitoring";
import { libraryRoute } from "../../lib/routes";
import { statusTone } from "../../lib/statusTone";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";

const DISMISSED_SOURCE_NOTICE_KEY = "print-partner.source-notice.dismissed";

type Notice = Readonly<{
  signature: string;
  title: string;
  detail: string;
  tone: "update" | "failure";
}>;

function activityNotice(event: SourceActivityEvent | undefined): Notice | null {
  if (!event) return null;
  switch (event.kind) {
    case "source.updated":
      return {
        signature: `event:${event.id}`,
        title: `${event.source_name} refreshed automatically`,
        detail: "Its Library revision moved. Builds using the older revision stay unchanged until you review and publish their Plan.",
        tone: "update",
      };
    case "source.sync_failed":
      return {
        signature: `event:${event.id}`,
        title: `${event.source_name} could not refresh`,
        detail: event.detail ?? "Open Source Library to retry the sync.",
        tone: "failure",
      };
    case "source.update_available":
      return {
        signature: `event:${event.id}`,
        title: `${event.source_name} has an update`,
        detail: "Review or sync it in Source Library.",
        tone: "update",
      };
    default: {
      const _exhaustive: never = event.kind;
      return _exhaustive;
    }
  }
}

export function sourceUpdateNotice(input: {
  updateIds: readonly number[];
  latestActivity?: SourceActivityEvent;
}): Notice | null {
  if (input.updateIds.length > 0) {
    const count = input.updateIds.length;
    return {
      signature: `updates:${[...input.updateIds].sort((a, b) => a - b).join(",")}`,
      title: `${count} source update${count === 1 ? "" : "s"} ready`,
      detail: "Review the changed Library revisions before publishing them into a Build.",
      tone: "update",
    };
  }
  return activityNotice(input.latestActivity);
}

function readDismissedSignature(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_SOURCE_NOTICE_KEY);
  } catch {
    return null;
  }
}

function dismissSignature(signature: string): void {
  try {
    window.localStorage.setItem(DISMISSED_SOURCE_NOTICE_KEY, signature);
  } catch {
    // A blocked storage API should not make the notice unusable for this session.
  }
}

export default function SourceUpdateNotice({ enabled }: { enabled: boolean }) {
  const [dismissed, setDismissed] = useState(readDismissedSignature);
  const { sources, activity } = useSourceMonitoringQueries(enabled);
  const updateIds = (sources.data ?? [])
    .filter((source) => source.update_status === "updates_available")
    .map((source) => source.id);
  const notice = sourceUpdateNotice({
    updateIds,
    latestActivity: activity.data?.[0],
  });

  if (!notice || dismissed === notice.signature) return null;

  return (
    <section
      className={
        notice.tone === "failure"
          ? cn(
              "mb-3 flex flex-wrap items-start gap-3 rounded-lg px-3 py-2.5 print:hidden",
              statusTone({ tone: "error", emphasis: "surface" }),
            )
          : "mb-3 flex flex-wrap items-start gap-3 rounded-lg border border-primary/40 bg-primary-soft px-3 py-2.5 print:hidden"
      }
      aria-label="Source update notification"
      role="status"
    >
      <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{notice.title}</p>
        <p className="text-xs text-muted-foreground">{notice.detail}</p>
      </div>
      <Button size="sm" variant="secondary" asChild>
        <Link to={libraryRoute()}>Open Source Library</Link>
      </Button>
      <button
        type="button"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Dismiss source update notification"
        onClick={() => {
          dismissSignature(notice.signature);
          setDismissed(notice.signature);
        }}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </section>
  );
}
