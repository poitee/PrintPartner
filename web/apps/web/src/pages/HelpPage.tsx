import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  BookOpen,
  ClipboardCheck,
  FileArchive,
  FolderGit2,
  FolderOpen,
  Hammer,
  Scale,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  engineBaseUrl,
  fetchHealth,
  fetchLegalDocument,
  fetchManifestRegistry,
  fetchWorkflowGuide,
  type ManifestRegistryEntry,
} from "../api/engine";
import SupportCta from "../components/SupportCta";
import PageHeader from "../components/layout/PageHeader";
import PageShell from "../components/layout/PageShell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useProfileSelection } from "../context/ProfileContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { buildSourcesRoute, checkoffRoute, exportRoute, planRoute } from "../lib/routes";
import { resolveEngineState } from "../lib/workflowState";

type LegalTab = "summary" | "license" | "attribution" | "third-party";

const LEGAL_TABS: { id: LegalTab; label: string }[] = [
  { id: "summary", label: "License overview" },
  { id: "license", label: "Full license" },
  { id: "attribution", label: "Attribution" },
  { id: "third-party", label: "Third-party notices" },
];

const WORKFLOW_STEP_ICONS: LucideIcon[] = [FolderGit2, Hammer, ClipboardCheck, FileArchive];

const WORKFLOW_STEPS = [
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

function renderMarkdownLite(text: string): string {
  return text
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`)
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(.+)$/gm, (line) =>
      line.startsWith("<") ? line : `<p>${line}</p>`,
    );
}

function HelpLoadingSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}

export default function HelpPage() {
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const { selectedProfileId } = useProfileSelection();
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const engineReady = engineState === "ready";
  const [legalTab, setLegalTab] = useState<LegalTab>("summary");
  const [legalText, setLegalText] = useState("");
  const [workflowText, setWorkflowText] = useState("");
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [legalLoading, setLegalLoading] = useState(false);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [legalError, setLegalError] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [engineUrl, setEngineUrl] = useState<string | null>(null);
  const [registryEntries, setRegistryEntries] = useState<ManifestRegistryEntry[]>([]);
  const [registryError, setRegistryError] = useState<string | null>(null);

  const stepPaths = WORKFLOW_STEPS.map((step) => {
    if (step.path) return step.path;
    if (step.label === "Sources") return buildSourcesRoute(selectedProfileId);
    if (step.label === "Plan") return planRoute(selectedProfileId);
    if (step.label === "Checkoff") return checkoffRoute(selectedProfileId);
    if (step.label === "Production") return exportRoute(selectedProfileId);
    return planRoute(selectedProfileId);
  });

  useEffect(() => {
    if (!engineReady) {
      setDataDir(null);
      return;
    }
    void fetchHealth()
      .then((h) => setDataDir(h.data_dir))
      .catch(() => setDataDir(null));
    void engineBaseUrl().then(setEngineUrl);
  }, [engineReady]);

  const loadWorkflow = useCallback(async () => {
    setWorkflowError(null);
    setWorkflowLoading(true);
    try {
      const text = await fetchWorkflowGuide();
      setWorkflowText(text);
    } catch (e) {
      setWorkflowError(e instanceof Error ? e.message : String(e));
      setWorkflowText("");
    } finally {
      setWorkflowLoading(false);
    }
  }, []);

  const loadLegal = useCallback(async (tab: LegalTab) => {
    setLegalError(null);
    setLegalLoading(true);
    try {
      const text = await fetchLegalDocument(tab);
      setLegalText(text);
    } catch (e) {
      setLegalError(e instanceof Error ? e.message : String(e));
      setLegalText("");
    } finally {
      setLegalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!engineReady) return;
    void loadWorkflow();
  }, [engineReady, loadWorkflow]);

  useEffect(() => {
    if (!engineReady) return;
    void loadLegal(legalTab);
  }, [engineReady, legalTab, loadLegal]);

  useEffect(() => {
    if (!engineReady) return;
    setRegistryError(null);
    setRegistryLoading(true);
    void fetchManifestRegistry()
      .then(setRegistryEntries)
      .catch((e) => {
        setRegistryError(e instanceof Error ? e.message : String(e));
        setRegistryEntries([]);
      })
      .finally(() => setRegistryLoading(false));
  }, [engineReady]);

  return (
    <PageShell width="reading">
      <PageHeader
        icon={BookOpen}
        accent
        title="Help"
        description="Workflow guide, data folders, and license information."
        actions={<SupportCta />}
      />

      <Card>
        <CardHeader accent>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-brand/10 text-accent-brand">
              <Workflow className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <CardTitle className="text-base">Workflow</CardTitle>
              <CardDescription>Sources → Plan → Checkoff → Production</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {WORKFLOW_STEPS.map((step, index) => {
              const StepIcon = WORKFLOW_STEP_ICONS[index];
              return (
                <li key={step.num}>
                  <Link
                    to={stepPaths[index]}
                    className="flex h-full flex-col rounded-lg border border-border bg-muted/20 p-3 transition-colors hover:border-primary/40 hover:bg-muted/40"
                  >
                    <span className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <StepIcon className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <span className="text-xs font-medium text-primary">Step {step.num}</span>
                    </span>
                    <span className="mt-2 font-medium">{step.label}</span>
                    <span className="mt-1 text-xs text-muted-foreground">{step.description}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <Card id="kit-variants">
        <CardHeader accent>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Hammer className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <CardTitle className="text-base">Kit variants</CardTitle>
              <CardDescription>
                Optional per-repo manifests that let you pick one variant per group on Plan.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Sync the source, then on <strong className="font-medium text-foreground">Plan</strong>{" "}
              apply a stack preset (if available) or attach the base repo.
            </li>
            <li>
              Expand the base source card → <strong className="font-medium text-foreground">Kit variants</strong>{" "}
              and pick one option per group (selections save automatically).
            </li>
            <li>
              Run <strong className="font-medium text-foreground">Update plan</strong> so variant
              parts appear on Plan.
            </li>
          </ol>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              Add a repo-root{" "}
              <code className="font-mono text-xs">print-partner.manifest.yaml</code> with{" "}
              <code className="font-mono text-xs">pick_one</code> option groups, then sync the
              source.
            </li>
            <li>
              Stack presets (when configured) attach base + addon layers and pre-fill variant
              choices — see the workflow guide below for how to define them.
            </li>
          </ul>
          <p className="text-xs">
            Maintainer docs:{" "}
            <a
              href="https://github.com/poitee/PrintPartner/blob/main/docs/playbooks/kit-studio-build.md"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              kit-studio-build playbook
            </a>
          </p>
        </CardContent>
      </Card>

      <Card id="creating-a-manifest">
        <CardHeader accent>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info">
              <BookOpen className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <CardTitle className="text-base">Workflow guide</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {workflowError && <p className="text-sm text-destructive">{workflowError}</p>}
          {!engineReady && (
            <p className="text-sm text-muted-foreground">
              {engineState === "offline"
                ? "Start the engine to load the workflow guide."
                : "Connecting to the engine…"}
            </p>
          )}
          {workflowLoading && engineReady && !workflowText && <HelpLoadingSkeleton />}
          {workflowText ? (
            <div
              className="help-prose text-sm leading-relaxed [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_li]:ml-4 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:space-y-1"
              dangerouslySetInnerHTML={{ __html: renderMarkdownLite(workflowText) }}
            />
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader accent>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FolderGit2 className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <CardTitle className="text-base">Community manifest registry</CardTitle>
              <CardDescription>
                Approved manifests from the Print Partner repo. Link a slug on a source or use a
                repo-root <code className="font-mono text-xs">print-partner.manifest.yaml</code> after
                sync.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {registryError && <p className="text-sm text-destructive">{registryError}</p>}
          {!engineReady && (
            <p className="text-sm text-muted-foreground">
              {engineState === "offline"
                ? "Start the engine to browse approved manifests."
                : "Connecting to the engine…"}
            </p>
          )}
          {registryLoading && engineReady && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}
          {engineReady && registryEntries.length === 0 && !registryError && !registryLoading && (
            <p className="text-sm text-muted-foreground">No approved community manifests yet.</p>
          )}
          {registryEntries.length > 0 && (
            <ul className="space-y-3">
              {registryEntries.map((entry) => (
                <li
                  key={entry.slug}
                  className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm"
                >
                  <strong>{entry.title ?? entry.slug}</strong>
                  <span className="font-mono text-xs text-muted-foreground">{entry.slug}</span>
                  {entry.target_repo ? (
                    <a
                      href={entry.target_repo}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary hover:underline"
                    >
                      {entry.target_repo}
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">No repo URL</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader accent>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-brand/10 text-accent-brand">
              <FolderOpen className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <CardTitle className="text-base">Folders</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {dataDir ? (
              <>
                Data directory (inside the server):{" "}
                <code className="font-mono text-xs">{dataDir}</code>
              </>
            ) : (
              "Start the engine to see the data directory path."
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            With Docker, bind a host volume to this path (default compose volume:{" "}
            <code className="font-mono">print-partner-data</code> → <code className="font-mono">/data</code>
            ).
          </p>
          {engineUrl && (
            <p className="text-xs text-muted-foreground">
              Engine API: <code className="font-mono">{engineUrl}</code> · OpenAPI:{" "}
              <code className="font-mono">{engineUrl}/api/v1/openapi.json</code>
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader accent>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Scale className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <CardTitle className="text-base">Legal</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={legalTab} onValueChange={(v) => setLegalTab(v as LegalTab)}>
            <TabsList className="flex h-auto w-full flex-wrap gap-1 sm:flex-nowrap">
              {LEGAL_TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="min-h-9 flex-1 text-xs sm:flex-none sm:text-sm">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {LEGAL_TABS.map((t) => (
              <TabsContent key={t.id} value={t.id}>
                {legalError && <p className="text-sm text-destructive">{legalError}</p>}
                {!engineReady && (
                  <p className="text-sm text-muted-foreground">
                    {engineState === "offline"
                      ? "Start the engine to load license text."
                      : "Connecting to the engine…"}
                  </p>
                )}
                {legalLoading && engineReady && !legalText ? (
                  <HelpLoadingSkeleton />
                ) : (
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-3 text-xs leading-relaxed">
                    {legalText}
                  </pre>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </PageShell>
  );
}
