/**
 * Direct links to the running slicer GUIs so a user can open a slicer (to
 * inspect a plate, tweak a setting, or watch a slice run) without leaving
 * Print Partner.
 *
 * These are fixed local hostnames for the self-hosted slicer containers,
 * reverse-proxied by the shared media-stack Caddy instance under its
 * `http://*.home` wildcard block (see media-stack/config/caddy/Caddyfile —
 * no TLS is terminated for this block, so plain http is the only reachable
 * scheme; https://*.home 000s). Not something PP discovers at runtime, so
 * there is no server endpoint for these — if the deployment's hostnames or
 * scheme ever change, update this list.
 */
export type SlicerKind = "orca" | "prusa" | "bambu";

export type SlicerLink = {
  slicer: SlicerKind;
  label: string;
  url: string;
  hint: string;
};

export const SLICER_LINKS: SlicerLink[] = [
  {
    slicer: "orca",
    label: "OrcaSlicer",
    url: "http://orca.home",
    hint: "Klipper / Voron plates route here",
  },
  {
    slicer: "prusa",
    label: "PrusaSlicer",
    url: "http://prusa.home",
    hint: "Prusa XL plates route here",
  },
  {
    slicer: "bambu",
    label: "BambuStudio",
    url: "http://bambu.home",
    hint: "Bambu plates route here",
  },
];
