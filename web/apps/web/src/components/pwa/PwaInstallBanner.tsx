/**
 * PwaInstallBanner — shows a "Add to Home Screen" prompt on mobile browsers
 * that support the beforeinstallprompt event. Dismissed by the user or hidden
 * when already installed (standalone display mode).
 */
import { useState } from "react";
import { Download } from "lucide-react";
import { usePwaInstall } from "../../lib/pwaInstall";
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
    <div className="flex items-center gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-sm text-info shadow-sm">
      <Download className="h-4 w-4 shrink-0 text-info" />
      <span className="flex-1">
        Install <strong>Print Partner</strong> for offline floor use
      </span>
      <Button
        size="sm"
        variant="outline"
        className="border-info/30 text-info hover:bg-info-soft"
        onClick={promptInstall}
      >
        Install
      </Button>
      <button
        aria-label="Dismiss install prompt"
        className="ml-1 text-info hover:text-info"
        onClick={() => setDismissed(true)}
      >
        ✕
      </button>
    </div>
  );
}
