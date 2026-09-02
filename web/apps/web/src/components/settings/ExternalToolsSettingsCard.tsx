import {
  isExternalAccessMode,
  type ExternalAccessMode,
} from "@print-partner/contracts";
import { Bot, Cable, Power } from "lucide-react";
import {
  useExternalAccessSettingsQuery,
  useSaveExternalAccessSettingsMutation,
} from "../../queries/externalAccess";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { cn } from "@/lib/utils";

type Props = Readonly<{
  engineReady: boolean;
}>;

const OPTIONS: readonly Readonly<{
  mode: ExternalAccessMode;
  label: string;
  description: string;
  icon: typeof Power;
}>[] = [
  {
    mode: "off",
    label: "Off, keep it simple",
    description:
      "Hide API key and MCP controls. Saved keys stop authorizing external requests, but remain stored in case you turn access back on.",
    icon: Power,
  },
  {
    mode: "api",
    label: "API access",
    description:
      "Allow API keys for scripts and integrations. MCP connections stay off.",
    icon: Cable,
  },
  {
    mode: "api_and_mcp",
    label: "API and MCP",
    description:
      "Allow API keys and connected AI tools that can propose changes for review.",
    icon: Bot,
  },
];

export default function ExternalToolsSettingsCard({ engineReady }: Props) {
  const settingsQuery = useExternalAccessSettingsQuery(engineReady);
  const saveMutation = useSaveExternalAccessSettingsMutation();
  const mode = settingsQuery.data?.mode;
  const error = saveMutation.error ?? settingsQuery.error;

  return (
    <Card>
      <CardHeader accent>
        <CardTitle level={3} className="text-base">External tools</CardTitle>
        <CardDescription>
          Choose how much automation Print Partner shows and accepts. Sources,
          Plan, Production, Checkoff, printers, backups, and logs keep working in
          every mode.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!mode ? (
          <p className="text-sm text-muted-foreground" role="status">
            {error ? "Could not load external tool settings." : "Loading external tool settings…"}
          </p>
        ) : (
          <RadioGroup
            value={mode}
            aria-label="External tool access"
            disabled={!engineReady || saveMutation.isPending}
            onValueChange={(value) => {
              if (!isExternalAccessMode(value) || value === mode) return;
              saveMutation.mutate({ mode: value });
            }}
          >
            {OPTIONS.map((option) => {
              const Icon = option.icon;
              const selected = option.mode === mode;
              return (
                <label
                  key={option.mode}
                  htmlFor={`external-tools-${option.mode}`}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                    selected
                      ? "border-primary bg-accent/60 ring-2 ring-primary/60"
                      : "border-border-strong bg-card hover:bg-accent/40",
                  )}
                >
                  <RadioGroupItem
                    id={`external-tools-${option.mode}`}
                    value={option.mode}
                    size="shop"
                    className="mt-0.5"
                    aria-describedby={`external-tools-${option.mode}-description`}
                  />
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground">
                      {option.label}
                    </span>
                    <span
                      id={`external-tools-${option.mode}-description`}
                      className="mt-0.5 block text-xs text-muted-foreground"
                    >
                      {option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>
        )}
        {saveMutation.isPending ? (
          <p className="text-xs text-muted-foreground" role="status">Saving…</p>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error instanceof Error ? error.message : String(error)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
