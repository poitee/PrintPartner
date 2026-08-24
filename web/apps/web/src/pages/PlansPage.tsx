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
import { cn } from "@/lib/utils";
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
  const loadingAnnouncement =
    engineState === "loading"
      ? "Connecting to the engine…"
      : profilesState === "loading"
        ? "Loading builds…"
        : "";

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
  const emptyAll = engineState === "ready" && profilesState === "ready" && profiles.length === 0;
  const emptyFilter = profilesState === "ready" && profiles.length > 0 && rows.length === 0;

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
              className="min-h-10 w-full sm:w-auto"
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
        <Card className="border-destructive/40 bg-destructive/5 shadow-none">
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
                          selected && "border-primary/35 bg-primary/8",
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
              <div className="overflow-x-auto">
              <table
                className="w-full min-w-[36rem] border-collapse text-sm"
                aria-label="Builds"
              >
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Name</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Remaining</th>
                    <th className="py-2 pr-3 font-medium">Parts</th>
                    <th className="py-2 pr-3 font-medium">Stale</th>
                    <th className="py-2 pr-3 font-medium">Checkoff</th>
                    <th className="py-2 pr-3 font-medium">Production</th>
                    <th className="py-2 pl-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((plan) => {
                    const selected = plan.id === selectedProfileId;
                    return (
                      <tr
                        key={plan.id}
                        className={cn(
                          "border-b border-border/80 transition-colors",
                          selected ? "bg-primary/8" : "hover:bg-muted/40",
                        )}
                      >
                        <td className="py-2.5 pr-3">
                          <button
                            type="button"
                            className={cn(
                              "max-w-[16rem] truncate text-left font-medium underline-offset-2 hover:underline",
                              selected && "text-primary",
                            )}
                            aria-label={`Open ${plan.name}`}
                            onClick={() => openBuild(plan.id)}
                            disabled={engineState !== "ready"}
                          >
                            {plan.name}
                          </button>
                        </td>
                        <td className="py-2.5 pr-3 text-muted-foreground">
                          {planStatusLabel(plan)}
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-muted-foreground">
                          <span className="inline-flex items-center gap-2">
                            <PlanProgressBar progress={plan.accepted_progress} />
                            {planProgressLabel(plan.accepted_progress)}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-muted-foreground">
                          {plan.part_count}
                        </td>
                        <td className="py-2.5 pr-3 text-muted-foreground">
                          {plan.build_stale ? (
                            <span className="text-xs">stale</span>
                          ) : (
                            <span className="sr-only">fresh</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          <Link
                            className="text-xs underline-offset-2 hover:underline"
                            to={progressRoute(plan.id)}
                            aria-label={`Checkoff for ${plan.name}`}
                          >
                            Checkoff
                          </Link>
                        </td>
                        <td className="py-2.5 pr-3">
                          <Link
                            className="text-xs underline-offset-2 hover:underline"
                            to={productionRoute(plan.id)}
                            aria-label={`Production for ${plan.name}`}
                          >
                            Production
                          </Link>
                        </td>
                        <td className="py-2.5 pl-2 text-right">
                          {renderPlanActions(plan)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
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
  return (
    <span
      className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted align-middle"
      aria-hidden
    >
      <span
        className="block h-full rounded-full bg-success"
        style={{ width: `${percent}%` }}
      />
    </span>
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
