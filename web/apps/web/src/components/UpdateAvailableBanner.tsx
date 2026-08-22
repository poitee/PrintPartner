import { ExternalLink, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { AppUpdateCheckResponse } from "@print-partner/contracts";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

const DISMISS_PREFIX = "pp-update-banner-dismissed:";

function dismissKey(latestVersion: string): string {
  return `${DISMISS_PREFIX}${latestVersion}`;
}

export function isUpdateBannerDismissed(latestVersion: string | null): boolean {
  if (!latestVersion || typeof localStorage === "undefined") return false;
  return localStorage.getItem(dismissKey(latestVersion)) === "1";
}

export function dismissUpdateBanner(latestVersion: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(dismissKey(latestVersion), "1");
}

type UpdateAvailableBannerProps = {
  updateCheck: AppUpdateCheckResponse;
  dismissed: boolean;
  onDismiss: () => void;
  className?: string;
};

export default function UpdateAvailableBanner({
  updateCheck,
  dismissed,
  onDismiss,
  className,
}: UpdateAvailableBannerProps) {
  if (!updateCheck.update_available || !updateCheck.latest_version || dismissed) {
    return null;
  }

  const releaseUrl = updateCheck.release_url ?? updateCheck.release_notes_url;
  const dockerHint =
    updateCheck.deploy_mode === "self-host"
      ? " Upgrade with docker compose pull && docker compose up --build."
      : "";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground sm:px-5 print:hidden",
        className,
      )}
      role="status"
    >
      <p className="min-w-0 flex-1 leading-snug">
        <span className="font-medium">Print Partner {updateCheck.latest_version}</span> is available
        (you are on {updateCheck.current_version}).
        {dockerHint}
      </p>
      <div className="flex shrink-0 items-center gap-1">
        {releaseUrl && (
          <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" asChild>
            <a href={releaseUrl} target="_blank" rel="noopener noreferrer">
              Release notes
              <ExternalLink className="ml-1 h-3 w-3" />
            </a>
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
          <Link to="/settings#about-updates">Settings</Link>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          aria-label="Dismiss update notice"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
