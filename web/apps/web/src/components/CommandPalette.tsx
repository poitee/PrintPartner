import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  startExportKitBundle,
  startExportStlPack,
  startSync,
  type StlPackGroupBy,
} from "../api/engine";
import { usePlanActions } from "../context/PlanActionsContext";
import { usePlanWorkspace } from "../context/PlanWorkspaceContext";
import { useProfileSelection } from "../context/ProfileContext";
import { useFlushBuildPageSaves } from "../hooks/useFlushBuildPageSaves";
import { useImportSharedBuild } from "../hooks/useImportSharedBuild";
import { useEngineHealth } from "../hooks/useEngineHealth";
import { useJobRunner } from "../hooks/useJobRunner";
import { checkoffUnitTotals } from "../lib/checkoffProgress";
import { completeExportDownload } from "../lib/exportActions";
import { handleStlPackExportJobDone } from "../lib/exportStlJobResult";
import { flattenReviewParts } from "../lib/reviewParts";
import { globalSectionPath } from "../lib/siteMap";
import {
  buildsRoute,
  buildSourcesRoute,
  checkoffRoute,
  exportRoute,
  helpRoute,
  isBuildPath,
  isLibraryPath,
  isPartsPath,
  partsRoute,
  printersRoute,
  settingsRoute,
  sourcesRoute,
} from "../lib/routes";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./ui/command";

type Action = {
  id: string;
  label: string;
  hint?: string;
  group: "Navigate" | "Workflow" | "Actions";
  disabled?: boolean;
  run: () => void;
};

type Props = Record<string, never>;

export default function CommandPalette(_props?: Props) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { health } = useEngineHealth();
  const { selectedProfileId } = useProfileSelection();
  const { review } = usePlanWorkspace();
  const { openCreatePlan } = usePlanActions();
  const flushBuildSaves = useFlushBuildPageSaves();
  const importSharedBuild = useImportSharedBuild();
  const syncJob = useJobRunner("sync");
  const stlExportJob = useJobRunner("stl-export");
  const kitExportJob = useJobRunner("kit-export");

  const remainingUnits = useMemo(() => {
    if (!review || review.profile_id !== selectedProfileId) return null;
    const included = flattenReviewParts(review.part_groups).filter((p) => p.included);
    return checkoffUnitTotals(included).remainingUnits;
  }, [review, selectedProfileId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onBuild = isBuildPath(location.pathname);
  const onReview = isPartsPath(location.pathname);
  const onLibrary = isLibraryPath(location.pathname);

  const actions: Action[] = useMemo(() => {
    const leaveBuildThen = (go: () => void) => {
      if (onBuild) void flushBuildSaves().then(go);
      else go();
    };

    const list: Action[] = [
      {
        id: "nav-builds",
        label: "Go to Builds",
        hint: location.pathname === "/builds" || location.pathname === "/plans" ? "current" : undefined,
        group: "Navigate",
        run: () => {
          leaveBuildThen(() => {
            navigate(buildsRoute(selectedProfileId));
            setOpen(false);
          });
        },
      },
      {
        id: "nav-sources",
        label: "Go to Sources",
        hint: onBuild ? "current" : undefined,
        group: "Navigate",
        run: () => {
          navigate(buildSourcesRoute(selectedProfileId));
          setOpen(false);
        },
      },
      {
        id: "search-stl",
        label: "Search all repos for part…",
        hint: "Library · cross-repo STL",
        group: "Navigate",
        disabled: !health,
        run: () => {
          leaveBuildThen(() => {
            navigate(sourcesRoute(), { state: { stlSearch: true } });
            setOpen(false);
          });
        },
      },
      {
        id: "nav-library",
        label: "Go to source library",
        hint: onLibrary ? "current" : undefined,
        group: "Navigate",
        run: () => {
          leaveBuildThen(() => {
            navigate(sourcesRoute());
            setOpen(false);
          });
        },
      },
      {
        id: "nav-plan",
        label: "Go to Plan",
        hint: onReview ? "current" : undefined,
        group: "Navigate",
        run: () => {
          leaveBuildThen(() => {
            navigate(partsRoute(selectedProfileId));
            setOpen(false);
          });
        },
      },
      {
        id: "nav-checkoff",
        label: "Go to Checkoff",
        hint:
          location.pathname === "/progress" || location.pathname === "/checkoff"
            ? "current"
            : undefined,
        group: "Navigate",
        run: () => {
          leaveBuildThen(() => {
            navigate(checkoffRoute(selectedProfileId));
            setOpen(false);
          });
        },
      },
      {
        id: "nav-production",
        label: "Go to Production",
        hint: location.pathname === "/production" ? "current" : undefined,
        group: "Navigate",
        run: () => {
          leaveBuildThen(() => {
            navigate(globalSectionPath("production"));
            setOpen(false);
          });
        },
      },
      {
        id: "nav-printers",
        label: "Go to Printers",
        hint: location.pathname === "/printers" ? "current" : undefined,
        group: "Navigate",
        run: () => {
          leaveBuildThen(() => {
            navigate(printersRoute());
            setOpen(false);
          });
        },
      },
      {
        id: "nav-settings",
        label: "Go to Settings",
        group: "Navigate",
        run: () => {
          leaveBuildThen(() => {
            navigate(settingsRoute());
            setOpen(false);
          });
        },
      },
      {
        id: "nav-help",
        label: "Go to Help",
        group: "Navigate",
        run: () => {
          leaveBuildThen(() => {
            navigate(helpRoute());
            setOpen(false);
          });
        },
      },
      {
        id: "create-plan",
        label: "New Build",
        hint: "Open create-build dialog",
        group: "Workflow",
        run: () => {
          openCreatePlan();
          setOpen(false);
        },
      },
    ];

    if (health && selectedProfileId != null) {
      list.push(
        {
          id: "export-share",
          label: "Share build…",
          hint: "Export .print-partner-kit.zip",
          group: "Workflow",
          disabled: kitExportJob.busy,
          run: () => {
            void kitExportJob.runJob(
              () => startExportKitBundle(selectedProfileId, false),
              (snap) => {
                if (snap.status === "error") {
                  toast.error(snap.message || "Export failed");
                  return;
                }
                completeExportDownload("Share build", snap.result);
              },
            );
            if (!onBuild && !onReview) navigate(buildSourcesRoute(selectedProfileId));
            setOpen(false);
          },
        },
        ...(["color_dir", "color"] as const).flatMap((groupBy: StlPackGroupBy) => {
          const groupHint =
            groupBy === "color" ? "color only" : "color + directory";
          return [
            {
              id: `export-stl-${groupBy}`,
              label: `Export STLs (${groupHint})`,
              hint: `Plan #${selectedProfileId}`,
              group: "Actions" as const,
              disabled: stlExportJob.busy,
              run: () => {
                void stlExportJob.runJob(
                  () => startExportStlPack(selectedProfileId, { group_by: groupBy }),
                  (snap) => {
                    handleStlPackExportJobDone("STL export", snap, {
                      pathField: "root_path",
                    });
                  },
                );
                if (!onBuild && !onReview) {
                  navigate(partsRoute(selectedProfileId));
                }
                setOpen(false);
              },
            },
            {
              id: `export-remaining-stl-${groupBy}`,
              label:
                remainingUnits != null
                  ? `Export remaining ${remainingUnits} (${groupHint})`
                  : `Export remaining (${groupHint})`,
              hint: "This Build · Checkoff",
              group: "Actions" as const,
              disabled: stlExportJob.busy || remainingUnits === 0,
              run: () => {
                void stlExportJob.runJob(
                  () =>
                    startExportStlPack(selectedProfileId, {
                      missing_only: true,
                      group_by: groupBy,
                    }),
                  (snap) => {
                    handleStlPackExportJobDone("Export remaining", snap, {
                      pathField: "root_path",
                    });
                  },
                );
                navigate(exportRoute(selectedProfileId));
                setOpen(false);
              },
            },
          ];
        }),
      );
    }

    if (health) {
      list.push(
        {
          id: "search-stl-global",
          label: "Search all repos for part…",
          hint: "Cross-repo STL discovery",
          group: "Actions",
          run: () => {
            navigate(sourcesRoute(), { state: { stlSearch: true } });
            setOpen(false);
          },
        },
        {
          id: "import-shared-build",
          label: "Import shared build…",
          hint: ".print-partner-kit.zip",
          group: "Actions",
          run: () => {
            void importSharedBuild().finally(() => setOpen(false));
          },
        },
        {
          id: "sync-all",
          label: "Sync all sources",
          group: "Actions",
          disabled: syncJob.busy,
          run: () => {
            navigate(sourcesRoute());
            void syncJob.runJob(() => startSync());
            setOpen(false);
          },
        },
      );
    }

    return list;
  }, [
    health,
    selectedProfileId,
    remainingUnits,
    navigate,
    syncJob,
    stlExportJob,
    kitExportJob,
    onBuild,
    onReview,
    onLibrary,
    location.pathname,
    flushBuildSaves,
    importSharedBuild,
    openCreatePlan,
  ]);

  const groups = ["Navigate", "Workflow", "Actions"] as const;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command…" />
      <CommandList>
        <CommandEmpty>No matching commands.</CommandEmpty>
        {groups.map((group, index) => {
          const items = actions.filter((a) => a.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              {index > 0 && <CommandSeparator />}
              <CommandGroup heading={group}>
                {items.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={`${a.label} ${a.hint ?? ""}`}
                    disabled={a.disabled}
                    onSelect={a.run}
                  >
                    <span>{a.label}</span>
                    {a.hint && (
                      <span className="ml-auto text-xs text-muted-foreground">{a.hint}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </div>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
