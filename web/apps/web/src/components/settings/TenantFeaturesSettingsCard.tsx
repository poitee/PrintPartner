import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { featureKeys, type FeatureKey } from "@print-partner/contracts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";
import {
  usePatchTenantFeaturesMutation,
  useTenantFeaturesQuery,
} from "../../queries/tenantFeatures";

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

export default function TenantFeaturesSettingsCard({
  engineReady = true,
}: {
  engineReady?: boolean;
}) {
  const { data, error, isLoading } = useTenantFeaturesQuery(engineReady);
  const patchMutation = usePatchTenantFeaturesMutation();
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleToggle = (key: FeatureKey, checked: boolean) => {
    setSaveError(null);
    patchMutation.mutate(
      { [key]: checked },
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
            <CardTitle level={3} className="text-base">Feature toggles</CardTitle>
            <CardDescription>
              Choose optional workflows for your account. Individual Plans can override these choices.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading feature toggles…</p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            Could not load feature toggles: {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        {saveError && (
          <p className="text-sm text-destructive" role="alert">
            Failed to save feature toggle: {saveError}
          </p>
        )}
        {data && (
          <div className="space-y-3">
            {featureKeys.map((key) => {
              const spec = FEATURE_METADATA[key];
              const isEnabled = Boolean(data.effective[key]?.enabled);
              return (
                <label
                  key={key}
                  htmlFor={`feature-toggle-${key}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="space-y-0.5">
                    <span className="text-sm font-medium">{spec.title}</span>
                    <p className="text-xs text-muted-foreground">{spec.description}</p>
                  </div>
                  <Switch
                    id={`feature-toggle-${key}`}
                    checked={isEnabled}
                    disabled={!engineReady || patchMutation.isPending}
                    onCheckedChange={(checked) => handleToggle(key, checked)}
                    aria-label={spec.title}
                  />
                </label>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
