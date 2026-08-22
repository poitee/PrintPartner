/**
 * usePwaInstall — exposes the browser's "Add to Home Screen" prompt.
 *
 * Usage:
 *   const { canInstall, promptInstall } = usePwaInstall();
 *   if (canInstall) <button onClick={promptInstall}>Install app</button>
 *
 * The browser fires `beforeinstallprompt` only when the PWA criteria are met
 * (HTTPS, manifest, service worker). On iOS the prompt is not available; users
 * must use Safari's Share → "Add to Home Screen" manually.
 */

import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") setDeferredPrompt(null);
  }, [deferredPrompt]);

  return { canInstall: deferredPrompt !== null, promptInstall };
}
