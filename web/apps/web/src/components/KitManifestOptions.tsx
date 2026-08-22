import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchPlanKitManifest,
  fetchPlanManifestBuilder,
  type KitManifest,
  type RepoManifestOptionGroup,
} from "../api/engine";
import { useKitManifestSaveRegistry } from "../context/KitManifestSaveContext";
import { useKitManifestAutosave } from "../hooks/useKitManifestAutosave";
import {
  kitManifestSaveStatusLabel,
  shouldShowKitManifestRetry,
} from "../lib/kitManifestSave";
import { ChevronDown } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

type Props = {
  profileId: number;
  baseSourceName?: string | null;
  buildStale?: boolean;
  disabled?: boolean;
  /** Nested inside a source card — omit outer card chrome. */
  compact?: boolean;
};

function groupLabel(groupId: string, group: RepoManifestOptionGroup): string {
  return group.label?.trim() || groupId.replace(/_/g, " ");
}

function variantLabel(variant: { id: string; label?: string | null }): string {
  return variant.label?.trim() || variant.id.replace(/_/g, " ");
}

export default function KitManifestOptions({
  profileId,
  baseSourceName,
  buildStale = false,
  disabled = false,
  compact = false,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedKit, setSavedKit] = useState<KitManifest | null>(null);
  const [savedSelections, setSavedSelections] = useState<Record<string, string>>({});
  const [pendingSelections, setPendingSelections] = useState<Record<string, string>>({});
  const [userEdited, setUserEdited] = useState(false);
  const [optionGroups, setOptionGroups] = useState<Record<string, RepoManifestOptionGroup>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);

  const { registerFlush, unregisterFlush } = useKitManifestSaveRegistry();

  const onSaved = useCallback((kit: KitManifest) => {
    setSavedKit(kit);
    setSavedSelections({ ...kit.selections });
    setUserEdited(false);
  }, []);

  const { dirty, status, saveNow, saveUserEdit } = useKitManifestAutosave({
    profileId,
    pendingSelections,
    savedSelections,
    loaded,
    userEdited,
    disabled,
    baseKit: savedKit,
    onSaved,
    onRegisterFlush: registerFlush,
    onUnregisterFlush: unregisterFlush,
  });

  const saveStatusLabel = kitManifestSaveStatusLabel(status);
  const showRetry = shouldShowKitManifestRetry(status);

  useEffect(() => {
    setLoaded(false);
    setLoadError(null);
    setUserEdited(false);
    setSavedKit(null);
    setSavedSelections({});
    setPendingSelections({});
    setOptionGroups({});

    let cancelled = false;
    void (async () => {
      try {
        const [builder, kit] = await Promise.all([
          fetchPlanManifestBuilder(profileId),
          fetchPlanKitManifest(profileId),
        ]);
        if (cancelled) return;
        let groups = builder.merged_option_groups ?? {};
        if (Object.keys(groups).length === 0 && Object.keys(kit.selections ?? {}).length > 0) {
          groups = Object.fromEntries(
            Object.entries(kit.selections).map(([groupId, variantId]) => [
              groupId,
              {
                rule: "pick_one",
                label: groupId.replace(/_/g, " "),
                parts: [],
                variants: [{ id: variantId, label: variantId.replace(/_/g, " "), parts: [] }],
              },
            ]),
          );
        }
        setOptionGroups(groups);
        setSavedKit(kit);
        const selections = { ...kit.selections };
        for (const [gid, group] of Object.entries(groups)) {
          if (!selections[gid] && group.variants?.length === 1) {
            selections[gid] = group.variants[0]!.id;
          }
        }
        setSavedSelections(selections);
        setPendingSelections(selections);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const visibleGroups = useMemo(
    () =>
      Object.entries(optionGroups).filter(
        ([, group]) => (group.rule ?? "pick_one") === "pick_one" && (group.variants?.length ?? 0) > 0,
      ),
    [optionGroups],
  );
  const title = baseSourceName ? `${baseSourceName} kit variants` : "Kit variants";
  const TitleHeading = compact ? "h3" : "h2";
  const GroupHeading = compact ? "h4" : "h3";

  const onPickVariant = (groupId: string, variantId: string) => {
    const next = { ...pendingSelections, [groupId]: variantId };
    setPendingSelections(next);
    setUserEdited(true);
    saveUserEdit(next);
  };

  if (loadError) {
    return <p className="text-sm text-destructive">{loadError}</p>;
  }

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Loading kit options…</p>;
  }

  if (visibleGroups.length === 0) {
    const emptyHint = (
      <p className="text-xs text-muted-foreground">
        No variant manifest on this source — add a{" "}
        <code className="font-mono">print-partner.manifest.yaml</code> to the repo after sync.{" "}
        <Link to="/help#kit-variants" className="text-primary hover:underline">
          Learn about kit variants
        </Link>
      </p>
    );

    if (compact) {
      return (
        <details className="group rounded-md border border-border">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
            <TitleHeading className="text-xs font-semibold text-muted-foreground">
              {title}
            </TitleHeading>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-border px-3 pb-3 pt-2">{emptyHint}</div>
        </details>
      );
    }

    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-1">
          <TitleHeading className="text-sm font-semibold">{title}</TitleHeading>
          <p className="text-xs text-muted-foreground">
            Pick one option per group, then run{" "}
            <strong className="font-medium text-foreground">Rebuild plan</strong> to apply.
          </p>
        </div>
        {emptyHint}
      </section>
    );
  }

  const staleHint = buildStale ? (
    <p className="text-xs text-amber-700 dark:text-amber-300">
      Run <strong className="font-medium text-foreground">Rebuild plan</strong> to apply variant
      parts to Review and Checkoff.
    </p>
  ) : null;

  const inner = (
    <>
      {staleHint}
      {(saveStatusLabel || showRetry) && (
        <div className={cn("flex flex-wrap items-center justify-end gap-2", compact ? "mb-2" : "mb-3")}>
          <div className="flex shrink-0 items-center gap-2 text-xs" aria-live="polite">
            {saveStatusLabel && (
              <span
                className={cn(
                  "text-muted-foreground",
                  status === "saved" && "text-emerald-600 dark:text-emerald-400",
                  status === "error" && "text-destructive",
                )}
              >
                {saveStatusLabel}
              </span>
            )}
            {showRetry && (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={disabled}
                onClick={() => void saveNow()}
              >
                Retry
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-4">
        {visibleGroups.map(([groupId, group]) => {
          const selected = pendingSelections[groupId] ?? "";
          return (
            <div
              key={groupId}
              className="option-group space-y-2 rounded-md"
              data-kit-group={groupId}
            >
              <div className="flex flex-wrap items-center gap-2">
                <GroupHeading className="text-sm font-medium capitalize">
                  {groupLabel(groupId, group)}
                </GroupHeading>
                <Badge variant="muted">choose one</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {(group.variants ?? []).map((variant) => {
                  const active = selected === variant.id;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      disabled={disabled}
                      aria-pressed={active}
                      className={cn(
                        "min-h-10 rounded-md border px-3 py-2 text-sm transition-colors sm:min-h-0 sm:py-1.5",
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                      )}
                      onClick={() => onPickVariant(groupId, variant.id)}
                    >
                      {variantLabel(variant)}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  if (compact) {
    return (
      <details
        className={cn(
          "group rounded-md border border-border",
          dirty && "border-primary/40",
        )}
        open={detailsOpen || undefined}
        onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
          <TitleHeading className="text-xs font-semibold text-muted-foreground">
            {title}
          </TitleHeading>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-2 border-t border-border px-3 pb-3 pt-2">
          <p className="text-[11px] text-muted-foreground">
            Pick one per group, then{" "}
            <strong className="font-medium text-foreground">Rebuild plan</strong>.{" "}
            <Link to="/help#kit-variants" className="text-primary hover:underline">
              Help
            </Link>
          </p>
          {inner}
        </div>
      </details>
    );
  }

  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card p-4",
        dirty && "border-primary/40",
      )}
    >
      <div className="mb-1">
        <TitleHeading className="text-sm font-semibold">{title}</TitleHeading>
        <p className="text-xs text-muted-foreground">
          Pick one option per group, then run{" "}
          <strong className="font-medium text-foreground">Rebuild plan</strong> to apply.{" "}
          <Link to="/help#kit-variants" className="text-primary hover:underline">
            Help
          </Link>
        </p>
      </div>
      {inner}
    </section>
  );
}
