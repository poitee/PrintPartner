/** Public support / sponsorship links. */
export const SPONSOR_URL = "https://github.com/sponsors/poitee";
export const SPONSOR_BUTTON_LABEL = "Sponsor";

/** Open the GitHub Sponsors page in a new browser tab. */
export function openSponsor(): void {
  window.open(SPONSOR_URL, "_blank", "noopener,noreferrer");
}
