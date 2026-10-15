import { useState } from "react";
import { FlaskConical } from "lucide-react";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  choiceToOverridePatch,
  featureKeys,
  overrideToChoice,
  type FeatureKey,
  type PlanFeatureChoice,
} from "@print-partner/contracts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { SegmentedControl } from "../ui/segmented-control";
import {
  usePatchPlanFeaturesMutation,
  usePlanFeaturesQuery,
} from "../../queries/planFeatures";
import { useEngineHealth } from "../../hooks/useEngineHealth";

const FEATURE_METADATA: Record<FeatureKey, { title: string; description: string }> = {
  farm: {
    title: "Print farm",
    description: "Queue suggestions and fleet status for several printers.",
  },
  orders: {
    title: "Orders",
    description: "Order numbers and customer requests on Plans.",
  },
  bambu: {
    title: "Bambu printers",
    description: "Bambu Lab printer status and job handoff.",
  },
  spoolman: {
    title: "Spoolman",
    description: "Filament stock and connector access through Spoolman.",
  },
};

const SOURCE_LABELS: Record<"plan" | "user" | "default", string> = {
  plan: "Plan override",
  user: "Account setting",
  default: "Default",
};

export default function PlanFeaturesCard({
  profileId,
  disabled = false,
}: {
  profileId: number;
  disabled?: boolean;
}) {
  const { health, error: engineError, loading: healthLoading } = useEngineHealth();
  const engineReady = Boolean(health?.ok && !engineError && !healthLoading);
  const hasCapability = Boolean(
    health?.capabilities &&
    health.capabilities.includes(TENANT_FEATURE_TOGGLES_CAPABILITY),
  );

  const { data, error, isLoading } = usePlanFeaturesQuery(profileId, hasCapability && engineReady);
  const patchMutation = usePatchPlanFeaturesMutation(profileId);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!hasCapability) {
    return null;
  }

  const isControlsDisabled = disabled || !engineReady || patchMutation.isPending;

  const handleChoiceChange = (key: FeatureKey, choice: PlanFeatureChoice) => {
    setSaveError(null);
    const patchValue = choiceToOverridePatch(choice);
    patchMutation.mutate(
      { [key]: patchValue },
      {
        onError: (err) => {
          setSaveError(err instanceof Error ? err.message : String(err));
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader accent>
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-brand/10 text-accent-brand">
            <FlaskConical className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <CardTitle level={3} className="text-base">Plan feature toggles</CardTitle>
            <CardDescription>
              Customize optional features for this Plan or inherit default account settings.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading plan feature toggles…</p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            Could not load plan feature toggles: {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        {saveError && (
          <p className="text-sm text-destructive" role="alert">
            Failed to save plan feature toggle: {saveError}
          </p>
        )}
        {data && (
          <div className="space-y-3">
            {featureKeys.map((key) => {
              const spec = FEATURE_METADATA[key];
              const choice = overrideToChoice(data.overrides[key]);
              const effective = data.effective[key];
              const effectiveLabel = effective.enabled ? "On" : "Off";
              const sourceLabel = SOURCE_LABELS[effective.source];

              return (
                <div
                  key={key}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{spec.title}</span>
                      <span
                        data-testid={`effective-${key}`}
                        className="text-xs text-muted-foreground"
                      >
                        (Effective: {effectiveLabel} · {sourceLabel})
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{spec.description}</p>
                  </div>
                  <SegmentedControl<PlanFeatureChoice>
                    aria-label={`${spec.title} override`}
                    value={choice}
                    disabled={isControlsDisabled}
                    onValueChange={(nextChoice) => handleChoiceChange(key, nextChoice)}
                    options={[
                      {
                        value: "inherit",
                        label: "Inherit",
                        "aria-label": `${spec.title}: Inherit`,
                      },
                      {
                        value: "enabled",
                        label: "On",
                        "aria-label": `${spec.title}: On`,
                      },
                      {
                        value: "disabled",
                        label: "Off",
                        "aria-label": `${spec.title}: Off`,
                      },
                    ]}
                  />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
