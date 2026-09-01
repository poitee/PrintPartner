import { useMemo, useState } from "react";
import type { AcceptedProgressSummary } from "@print-partner/contracts";
import { Link, useNavigate } from "react-router-dom";
import {
  Archive,
  Copy,
  Layers,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import PageHeader from "../components/layout/PageHeader";
import PageHeaderActions from "../components/layout/PageHeaderActions";
import EmptyState from "../components/layout/EmptyState";
import PageShell from "../components/layout/PageShell";
import IncomingSharesCard from "../components/share/IncomingSharesCard";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { SegmentedControl } from "../components/ui/segmented-control";
import { usePlanActions } from "../context/PlanActionsContext";
import { useProfileSelection } from "../context/ProfileContext";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  canArchiveAcceptedPlan,
  filterPlansList,
  planProgressLabel,
  planStatusLabel,
  type PlansListFilter,
  type PlansListSort,
} from "../lib/plansList";
import { planRoute, productionRoute, progressRoute } from "../lib/routes";
import { isPlansListEmpty, plansLoadingAnnouncement } from "../lib/plansPageModel";
import { statusTone } from "../lib/statusTone";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getBackgroundError,
  resolveEngineState,
  resolveResourceState,
} from "../lib/workflowState";
import { useTouchProfileLastUsedMutation } from "../queries/profiles";

export default function PlansPage() {
  const navigate = useNavigate();
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const {
    profiles,
    selectedProfileId,
    setSelectedProfileId,
    loading,
    error: profilesError,
    reloadProfiles,
  } = useProfileSelection();
  const {
    openCreatePlan,
    openRenamePlan,
    openDuplicatePlan,
    openDeletePlan,
    openArchivePlan,
  } = usePlanActions();
  const touchMutation = useTouchProfileLastUsedMutation();
  const useCompactPlanList = useMediaQuery("(max-width: 639px)");

  const [filter, setFilter] = useState<PlansListFilter>("active");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<PlansListSort>("name");
  const engineState = resolveEngineState({
    health,
    loading: healthLoading,
    error: engineError,
  });
  const profilesState = resolveResourceState({
    loading,
    error: profilesError,
    hasData: profiles.length > 0,
  });
  const profilesBackgroundError = getBackgroundError(
    profilesError,
    profiles.length > 0,
  );
  const loadingAnnouncement = plansLoadingAnnouncement({ engineState, profilesState });

  const rows = useMemo(
    () => filterPlansList(profiles, filter, query, sort),
    [profiles, filter, query, sort],
  );

  const openBuild = (id: number) => {
    setSelectedProfileId(id);
    touchMutation.mutate(id);
    navigate(planRoute(id));
  };

  const renderPlanActions = (plan: (typeof rows)[number]) => {
    const archiveAllowed = canArchiveAcceptedPlan(plan);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={engineState !== "ready"}
            aria-label={`Actions for ${plan.name}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => openRenamePlan(plan.id)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDuplicatePlan(plan.id)}>
            <Copy className="mr-2 h-4 w-4" />
            Duplicate
          </DropdownMenuItem>
          {archiveAllowed ? (
            <DropdownMenuItem onClick={() => openArchivePlan(plan.id)}>
              <Archive className="mr-2 h-4 w-4" />
              Archive
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => openDeletePlan(plan.id)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // Profiles query is disabled until health.ok; treat that as not-yet-loaded, not empty.
  const { emptyAll, emptyFilter } = isPlansListEmpty({
    engineState,
    profilesState,
    profileCount: profiles.length,
    rowCount: rows.length,
  });

  return (
    <PageShell width="list">
      <PageHeader
        icon={Layers}
        accent
        eyebrow="Workshop"
        title="Builds"
        description="Open a Build into Plan, or start a new one. New Build asks only for a name."
        actions={engineState === "ready" && profilesState === "ready" && profiles.length > 0 ? (
          <PageHeaderActions>
            <Button
              size="shop"
              className="w-full sm:w-auto"
              onClick={openCreatePlan}
              disabled={engineState !== "ready" || profilesState !== "ready"}
            >
              New Build
            </Button>
          </PageHeaderActions>
        ) : undefined}
      />
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {loadingAnnouncement}
      </p>
      <IncomingSharesCard />

      {profilesBackgroundError && (
        <p className="text-sm text-destructive" role="alert">
              Could not refresh builds: {profilesBackgroundError}
        </p>
      )}

      {engineState !== "ready" ? (
        <Card>
          <CardContent className="pt-6">
            <p
              className="text-sm text-muted-foreground"
              aria-hidden={engineState === "loading" ? "true" : undefined}
            >
              {engineState === "offline"
                ? "Engine offline. Start the print-partner engine to manage builds."
                : "Connecting to the engine…"}
            </p>
          </CardContent>
        </Card>
      ) : profilesState === "error" ? (
        <Card className={cn("shadow-none", statusTone({ tone: "error", emphasis: "surface" }))}>
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm text-destructive" role="alert">
              Could not load builds: {profilesError}
            </p>
            <Button size="sm" variant="secondary" onClick={() => void reloadProfiles()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : profilesState === "loading" ? (
        <Card className="border-border shadow-sm">
          <CardContent className="pt-6">
            <p
              className="text-sm text-muted-foreground"
              aria-hidden="true"
            >
              Loading builds…
            </p>
          </CardContent>
        </Card>
      ) : emptyAll ? (
        <EmptyState
          icon={Layers}
          title="Name a Build to start."
          action={{ label: "New Build", onClick: openCreatePlan }}
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Input
              type="search"
              aria-label="Search builds"
              placeholder="Search builds"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="sm:max-w-xs"
            />
            <SegmentedControl
              aria-label="Build status filter"
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
                { value: "all", label: "All" },
              ]}
            />
            <SegmentedControl
              aria-label="Build sort"
              value={sort}
              onValueChange={setSort}
              options={[
                { value: "name", label: "Name" },
                { value: "recent", label: "Recent" },
              ]}
            />
          </div>

          {emptyFilter ? (
            <p className="text-sm text-muted-foreground">
              {query.trim()
                ? "No matching builds."
                : `No ${filter === "archived" ? "archived" : "active"} builds.`}
            </p>
          ) : (
            <>
              {useCompactPlanList ? (
              <ul className="space-y-2" aria-label="Builds">
                {rows.map((plan) => {
                  const selected = plan.id === selectedProfileId;
                  return (
                    <li key={plan.id}>
                      <Card
                        className={cn(
                          "shadow-none",
                          selected && "border-primary/40 bg-primary-soft",
                        )}
                      >
                        <CardContent className="space-y-3 p-3">
                          <div className="flex items-start gap-2">
                            <button
                              type="button"
                              className={cn(
                                "min-w-0 flex-1 truncate text-left font-medium underline-offset-2 hover:underline",
                                selected && "text-primary",
                              )}
                              aria-label={`Open ${plan.name}`}
                              onClick={() => openBuild(plan.id)}
                              disabled={engineState !== "ready"}
                            >
                              {plan.name}
                            </button>
                            {renderPlanActions(plan)}
                          </div>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
                            <span>{planStatusLabel(plan)}</span>
                            <span className="inline-flex items-center gap-2">
                              <PlanProgressBar progress={plan.accepted_progress} />
                              {planProgressLabel(plan.accepted_progress)}
                            </span>
                            <span>{plan.part_count} parts</span>
                            {plan.build_stale ? (
                              <span className="text-warning">stale</span>
                            ) : null}
                          </div>
                          <BuildStatusLinks id={plan.id} name={plan.name} />
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ul>
              ) : (
              <Table aria-label="Builds" className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[28%] px-0 pr-3">Name</TableHead>
                    <TableHead className="w-[9%] px-0 pr-3">Status</TableHead>
                    <TableHead className="w-[26%] px-0 pr-3">Remaining</TableHead>
                    <TableHead className="w-[7%] px-0 pr-3">Parts</TableHead>
                    <TableHead className="w-[7%] px-0 pr-3">Stale</TableHead>
                    <TableHead className="w-[9%] px-0 pr-3">Checkoff</TableHead>
                    <TableHead className="w-[10%] px-0 pr-3">Production</TableHead>
                    <TableHead className="w-[5%] px-0 pl-2">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((plan) => {
                    const selected = plan.id === selectedProfileId;
                    return (
                      <TableRow
                        key={plan.id}
                        data-state={selected ? "selected" : undefined}
                        className={cn(selected && "bg-primary-soft hover:bg-primary-soft")}
                      >
                        <TableCell className="px-0 py-2.5 pr-3">
                          <button
                            type="button"
                            className={cn(
                              "block w-full truncate text-left font-medium underline-offset-2 hover:underline",
                              selected && "text-primary",
                            )}
                            aria-label={`Open ${plan.name}`}
                            onClick={() => openBuild(plan.id)}
                            disabled={engineState !== "ready"}
                          >
                            {plan.name}
                          </button>
                        </TableCell>
                        <TableCell className="px-0 py-2.5 pr-3 text-muted-foreground">
                          {planStatusLabel(plan)}
                        </TableCell>
                        <TableCell className="px-0 py-2.5 pr-3 font-mono tabular-nums text-muted-foreground">
                          <span className="inline-flex items-center gap-2 whitespace-nowrap">
                            <PlanProgressBar progress={plan.accepted_progress} />
                            {planProgressLabel(plan.accepted_progress)}
                          </span>
                        </TableCell>
                        <TableCell className="px-0 py-2.5 pr-3 font-mono tabular-nums text-muted-foreground">
                          {plan.part_count}
                        </TableCell>
                        <TableCell className="px-0 py-2.5 pr-3 text-muted-foreground">
                          {plan.build_stale ? (
                            <span className="text-xs">stale</span>
                          ) : (
                            <span className="sr-only">fresh</span>
                          )}
                        </TableCell>
                        <TableCell className="px-0 py-2.5 pr-3">
                          <Link
                            className="text-xs underline-offset-2 hover:underline"
                            to={progressRoute(plan.id)}
                            aria-label={`Checkoff for ${plan.name}`}
                          >
                            Checkoff
                          </Link>
                        </TableCell>
                        <TableCell className="px-0 py-2.5 pr-3">
                          <Link
                            className="text-xs underline-offset-2 hover:underline"
                            to={productionRoute(plan.id)}
                            aria-label={`Production for ${plan.name}`}
                          >
                            Production
                          </Link>
                        </TableCell>
                        <TableCell className="px-0 py-2.5 pl-2 text-right">
                          {renderPlanActions(plan)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              )}
            </>
          )}
        </>
      )}
    </PageShell>
  );
}

function PlanProgressBar({ progress }: { progress: AcceptedProgressSummary }) {
  if (progress.kind !== "ready" || progress.total_units <= 0) return null;
  const done = progress.total_units - progress.remaining_units;
  const percent = Math.round((done / progress.total_units) * 100);
  // Decorative: the adjacent planProgressLabel already states the numbers, so a
  // second progressbar in the a11y tree would only repeat them.
  return (
    <Progress
      value={percent}
      tone="success"
      aria-hidden
      className="inline-block h-1.5 w-16 align-middle"
    />
  );
}

function BuildStatusLinks({ id, name }: { id: number; name: string }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      <Link
        className="underline-offset-2 hover:underline"
        to={progressRoute(id)}
        aria-label={`Checkoff for ${name}`}
      >
        Checkoff
      </Link>
      <Link
        className="underline-offset-2 hover:underline"
        to={productionRoute(id)}
        aria-label={`Production for ${name}`}
      >
        Production
      </Link>
    </div>
  );
}
