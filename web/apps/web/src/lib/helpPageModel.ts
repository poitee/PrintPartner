import { buildSourcesRoute, checkoffRoute, exportRoute, planRoute } from "./routes";

export type LegalTab = "summary" | "license" | "attribution" | "third-party";

export const LEGAL_TABS: readonly { id: LegalTab; label: string }[] = [
  { id: "summary", label: "License overview" },
  { id: "license", label: "Full license" },
  { id: "attribution", label: "Attribution" },
  { id: "third-party", label: "Third-party notices" },
];

export const WORKFLOW_STEPS = [
  {
    num: 1,
    label: "Sources",
    path: null as string | null,
    description: "Attach sources, pick STLs, and set role colors for this Build",
  },
  {
    num: 2,
    label: "Plan",
    path: null as string | null,
    description: "Review quantities and warnings, then apply Plan changes",
  },
  {
    num: 3,
    label: "Checkoff",
    path: null as string | null,
    description: "Track printed units and bag completed work",
  },
  {
    num: 4,
    label: "Production",
    path: null as string | null,
    description: "Allocate printers, edit plates, download, and verify jobs",
  },
] as const;

export function workflowStepPaths(selectedProfileId: number | null | undefined): string[] {
  return WORKFLOW_STEPS.map((step) => {
    if (step.path) return step.path;
    if (step.label === "Sources") return buildSourcesRoute(selectedProfileId);
    if (step.label === "Plan") return planRoute(selectedProfileId);
    if (step.label === "Checkoff") return checkoffRoute(selectedProfileId);
    if (step.label === "Production") return exportRoute(selectedProfileId);
    return planRoute(selectedProfileId);
  });
}

export function renderMarkdownLite(text: string): string {
  return text
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`)
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(.+)$/gm, (line) => (line.startsWith("<") ? line : `<p>${line}</p>`));
}
