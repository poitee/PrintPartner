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
    id: "sources",
    group: "prepare",
    label: "Sources",
    path: null as string | null,
    description: "Attach and verify the design inputs for this Build",
  },
  {
    id: "plan",
    group: "prepare",
    label: "Plan",
    path: null as string | null,
    description: "Review the Working Plan, resolve issues, then accept it",
  },
  {
    id: "production",
    group: "make",
    label: "Production",
    path: null as string | null,
    description: "Prepare plates and send selected units to printers",
  },
  {
    id: "checkoff",
    group: "make",
    label: "Checkoff",
    path: null as string | null,
    description: "Verify print results, then return failed or remaining work to Production",
  },
] as const;

export function workflowStepPaths(selectedProfileId: number | null | undefined): string[] {
  return WORKFLOW_STEPS.map((step) => {
    if (step.path) return step.path;
    if (step.label === "Sources") return buildSourcesRoute(selectedProfileId);
    if (step.label === "Plan") return planRoute(selectedProfileId);
    if (step.label === "Production") return exportRoute(selectedProfileId);
    if (step.label === "Checkoff") return checkoffRoute(selectedProfileId);
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
