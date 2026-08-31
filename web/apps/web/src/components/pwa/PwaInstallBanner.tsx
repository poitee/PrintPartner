/**
 * PwaInstallBanner — shows a "Add to Home Screen" prompt on mobile browsers
 * that support the beforeinstallprompt event. Dismissed by the user or hidden
 * when already installed (standalone display mode).
 */
import { useState } from "react";
import { Download } from "lucide-react";
import { usePwaInstall } from "../../lib/pwaInstall";
import { statusTone } from "../../lib/statusTone";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export default function PwaInstallBanner() {
  const { canInstall, promptInstall } = usePwaInstall();
  const [dismissed, setDismissed] = useState(false);

  // Don't show if already running in standalone / already installed
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true);

  if (!canInstall || dismissed || isStandalone) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-sm",
        statusTone({ tone: "info", emphasis: "soft" }),
      )}
    >
      <Download className={cn("h-4 w-4 shrink-0", statusTone({ tone: "info", emphasis: "text" }))} />
      <span className="flex-1">
        Install <strong>Print Partner</strong> for offline floor use
      </span>
      <Button
        size="sm"
        variant="outline"
        className={cn(statusTone({ tone: "info", emphasis: "outline" }), "hover:bg-info-soft")}
        onClick={promptInstall}
      >
        Install
      </Button>
      <button
        aria-label="Dismiss install prompt"
        className={cn("ml-1 hover:text-info", statusTone({ tone: "info", emphasis: "text" }))}
        onClick={() => setDismissed(true)}
      >
        ✕
      </button>
    </div>
  );
}
