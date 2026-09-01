/**
 * PwaInstallBanner — shows a "Add to Home Screen" prompt on mobile browsers
 * that support the beforeinstallprompt event. Dismissed by the user or hidden
 * when already installed (standalone display mode).
 */
import { useState } from "react";
import { Download, X } from "lucide-react";
import { usePwaInstall } from "../../lib/pwaInstall";
import { statusTone } from "../../lib/statusTone";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Alert, AlertActions, AlertTitle } from "../ui/alert";

export default function PwaInstallBanner() {
  const { canInstall, promptInstall } = usePwaInstall();
  const [dismissed, setDismissed] = useState(false);

  // Don't show if already running in standalone / already installed
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true);

  if (!canInstall || dismissed || isStandalone) return null;

  return (
    <Alert tone="info" role="status" className="items-center shadow-sm">
      <Download aria-hidden />
      <AlertTitle className="font-normal">
        Install <strong className="font-medium">Print Partner</strong> for offline floor use
      </AlertTitle>
      <AlertActions>
        <Button
          size="sm"
          variant="outline"
          className={cn(statusTone({ tone: "info", emphasis: "outline" }), "hover:bg-info-soft")}
          onClick={promptInstall}
        >
          Install
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss install prompt"
          className="size-8 hover:text-info"
          onClick={() => setDismissed(true)}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </AlertActions>
    </Alert>
  );
}
