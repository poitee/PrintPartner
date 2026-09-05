import { useCallback, useEffect, useMemo, useState } from "react";
import type { ManifestSelection, ManifestSelections } from "@print-partner/contracts";
import { Link } from "react-router-dom";
import {
  fetchPlanKitManifest,
  fetchPlanManifestBuilder,
  type KitManifest,
} from "../api/endpoints/planManifests";
import type { RepoManifestOptionGroup } from "../api/endpoints/sourceArtifacts";
import { useKitManifestSaveRegistry } from "../context/KitManifestSaveContext";
import { useKitManifestAutosave } from "../hooks/useKitManifestAutosave";
import {
  kitManifestSaveStatusLabel,
  shouldShowKitManifestRetry,
} from "../lib/kitManifestSave";
import { ChevronDown } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

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

function selectedVariantIds(selection: ManifestSelection | undefined): string[] {
  if (selection == null) return [];
  return Array.isArray(selection) ? selection : [selection];
}

function selectionInstruction(group: RepoManifestOptionGroup): string {
  if (group.rule === "pick_one") {
    return group.max === 0 ? "no selections" : "choose one";
  }
  const minimum = group.min ?? 0;
  const maximum = group.max ?? null;
  if (minimum > 0 && maximum === minimum) return `choose ${minimum}`;
  if (minimum > 0 && maximum != null) return `choose ${minimum} to ${maximum}`;
  if (minimum > 0) return `choose at least ${minimum}`;
  if (maximum != null) return `choose up to ${maximum}`;
  return "choose any";
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
  const [inheritedSelections, setInheritedSelections] = useState<ManifestSelections>({});
  const [savedSelections, setSavedSelections] = useState<ManifestSelections>({});
  const [pendingSelections, setPendingSelections] = useState<ManifestSelections>({});
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
  const displayedSelections = useMemo(
    () => ({ ...inheritedSelections, ...pendingSelections }),
    [inheritedSelections, pendingSelections],
  );

  useEffect(() => {
    setLoaded(false);
    setLoadError(null);
    setUserEdited(false);
    setSavedKit(null);
    setInheritedSelections({});
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
            Object.entries(kit.selections).map(([groupId, selection]) => {
              const variantIds = selectedVariantIds(selection);
              return [
                groupId,
                {
                  rule: Array.isArray(selection) ? "pick_any" : "pick_one",
                  label: groupId.replace(/_/g, " "),
                  parts: [],
                  variants: variantIds.map((variantId) => ({
                    id: variantId,
                    label: variantId.replace(/_/g, " "),
                    parts: [],
                  })),
                },
              ];
            }),
          );
        }
        setOptionGroups(groups);
        setSavedKit(kit);
        const explicitSelections = { ...kit.selections };
        const inherited = { ...(builder.resolved_selections ?? {}) };
        for (const groupId of Object.keys(explicitSelections)) {
          delete inherited[groupId];
        }
        setInheritedSelections(inherited);
        setSavedSelections(explicitSelections);
        setPendingSelections(explicitSelections);
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
        ([, group]) => (group.variants?.length ?? 0) > 0,
      ),
    [optionGroups],
  );
  const title = baseSourceName ? `${baseSourceName} kit variants` : "Kit variants";
  const TitleHeading = compact ? "h3" : "h2";
  const GroupHeading = compact ? "h4" : "h3";

  const onPickVariant = (
    groupId: string,
    group: RepoManifestOptionGroup,
    variantId: string,
  ) => {
    const next = { ...pendingSelections };
    if (group.rule === "pick_one") {
      next[groupId] = variantId;
    } else {
      const knownIds = new Set((group.variants ?? []).map((variant) => variant.id));
      const selected = new Set(
        selectedVariantIds(displayedSelections[groupId]).filter((id) => knownIds.has(id)),
      );
      if (selected.has(variantId)) {
        selected.delete(variantId);
      } else {
        if (group.max != null && selected.size >= group.max) return;
        selected.add(variantId);
      }
      const ordered = (group.variants ?? [])
        .map((variant) => variant.id)
        .filter((id) => selected.has(id));
      if (ordered.length > 0) next[groupId] = ordered;
      else next[groupId] = [];
    }
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
            Choose the options required by each group, then run{" "}
            <strong className="font-medium text-foreground">Build Working Plan</strong> to include it.
          </p>
        </div>
        {emptyHint}
      </section>
    );
  }

  const staleHint = buildStale ? (
    <p className="text-xs text-warning">
      Choose <strong className="font-medium text-foreground">Build Working Plan</strong> to include variant
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
                  status === "saved" && "text-success",
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
          const storedIds = selectedVariantIds(displayedSelections[groupId]);
          const availableIds = new Set((group.variants ?? []).map((variant) => variant.id));
          const selectedIds = storedIds.filter((id) => availableIds.has(id));
          const unavailableCount = storedIds.length - selectedIds.length;
          const minimum = group.min ?? 0;
          const maximum =
            group.rule === "pick_one"
              ? Math.min(group.max ?? 1, 1)
              : (group.max ?? null);
          const belowMinimum = selectedIds.length < minimum;
          const aboveMaximum =
            maximum != null && selectedIds.length > maximum;
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
                <Badge variant="muted">{selectionInstruction(group)}</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {(group.variants ?? []).map((variant) => {
                  const active = selectedIds.includes(variant.id);
                  const atMaximum =
                    maximum != null && selectedIds.length >= maximum;
                  const cannotAdd =
                    group.rule === "pick_one"
                      ? maximum === 0
                      : !active && atMaximum;
                  return (
                    <button
                      key={variant.id}
                      type="button"
                      disabled={disabled || cannotAdd}
                      aria-pressed={active}
                      className={cn(
                        "min-h-10 rounded-md border px-3 py-2 text-sm transition-colors sm:min-h-0 sm:py-1.5",
                        active
                          ? "border-primary bg-primary-soft text-foreground"
                          : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                      )}
                      onClick={() => onPickVariant(groupId, group, variant.id)}
                    >
                      {variantLabel(variant)}
                    </button>
                  );
                })}
              </div>
              {belowMinimum && (
                <p className="text-xs text-warning">
                  Choose at least {minimum} options.
                </p>
              )}
              {aboveMaximum && (
                <p className="text-xs text-warning">
                  Choose no more than {maximum} options.
                </p>
              )}
              {unavailableCount > 0 && (
                <p className="text-xs text-warning">
                  {unavailableCount} saved {unavailableCount === 1 ? "option is" : "options are"}{" "}
                  no longer available. Choose an available option to update this group.
                </p>
              )}
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
          <p className="text-micro text-muted-foreground">
            Choose the required options, then{" "}
            <strong className="font-medium text-foreground">Build Working Plan</strong>.{" "}
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
          Choose the options required by each group, then run{" "}
          <strong className="font-medium text-foreground">Build Working Plan</strong> to include it.{" "}
          <Link to="/help#kit-variants" className="text-primary hover:underline">
            Help
          </Link>
        </p>
      </div>
      {inner}
    </section>
  );
}
