import { toast } from "sonner";

const SPONSOR_URL = "https://github.com/sponsors/poitee";
export const SPONSOR_BUTTON_LABEL = "Sponsor";

declare global {
  interface Window {
    readonly __PRINT_PARTNER_NATIVE_SPONSOR__?: () => Promise<void>;
  }
}

export function openSponsor(): void {
  const nativeSponsor = window.__PRINT_PARTNER_NATIVE_SPONSOR__;
  if (nativeSponsor) {
    void Promise.resolve().then(() => nativeSponsor()).catch(() => {
      toast.error("Could not confirm your browser opened. Visit github.com/sponsors/poitee to sponsor Print Partner.");
    });
    return;
  }
  window.open(SPONSOR_URL, "_blank", "noopener,noreferrer");
}
