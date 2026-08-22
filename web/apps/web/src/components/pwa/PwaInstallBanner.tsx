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
    <div className="flex items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-950/40 px-4 py-3 text-sm text-sky-200 shadow-sm">
      <Download className="h-4 w-4 shrink-0 text-sky-400" />
      <span className="flex-1">
        Install <strong>Print Partner</strong> for offline floor use
      </span>
      <Button
        size="sm"
        variant="outline"
        className="border-sky-500/50 text-sky-300 hover:bg-sky-900/60"
        onClick={promptInstall}
      >
        Install
      </Button>
      <button
        aria-label="Dismiss install prompt"
        className="ml-1 text-sky-500 hover:text-sky-300"
        onClick={() => setDismissed(true)}
      >
        ✕
      </button>
    </div>
  );
}
