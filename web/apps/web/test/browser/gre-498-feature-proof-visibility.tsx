import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  TENANT_FEATURE_TOGGLES_CAPABILITY,
  featureKeys,
  type FeatureKey,
  type FeatureSettings,
  type PlanFeatures,
} from "@print-partner/contracts";
import { JobProvider } from "../../src/context/JobContext";
import TenantFeaturesSettingsCard from "../../src/components/settings/TenantFeaturesSettingsCard";
import PlanFeaturesCard from "../../src/components/plan/PlanFeaturesCard";
import PrinterSendQueuePanel from "../../src/components/export/PrinterSendQueuePanel";

const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "settings";
const enabled = params.get("enabled") === "1";
const profileId = 1;

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function effective(
  on: boolean,
  source: "default" | "user" | "plan",
): FeatureSettings["effective"] {
  return Object.fromEntries(
    featureKeys.map((key) => [key, { enabled: on, source }]),
  ) as FeatureSettings["effective"];
}

let accountOn = enabled && surface !== "plan";
let planOverrides: Partial<Record<FeatureKey, boolean | null>> = enabled && surface !== "account"
  ? Object.fromEntries(featureKeys.map((key) => [key, true]))
  : {};

function tenantFeatures(): FeatureSettings {
  const choices = Object.fromEntries(
    featureKeys.map((key) => [key, accountOn]),
  ) as FeatureSettings["choices"];
  return {
    choices,
    effective: effective(accountOn, accountOn ? "user" : "default"),
  };
}

function planFeatures(): PlanFeatures {
  const resolved = Object.fromEntries(
    featureKeys.map((key) => {
      const override = planOverrides[key];
      const on = override === true || (override == null && accountOn);
      const source = override === true ? "plan" : override === false ? "plan" : accountOn ? "user" : "default";
      return [key, { enabled: on, source }];
    }),
  ) as PlanFeatures["effective"];
  return { profile_id: profileId, overrides: planOverrides, effective: resolved };
}

const farmEffectiveOn = planFeatures().effective.farm.enabled;

window.fetch = async (input, init) => {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

  if (path === "/health") {
    return json({
      ok: true,
      version: "fixture",
      deploy_mode: "self-host",
      data_dir: "fixture",
      capabilities: [TENANT_FEATURE_TOGGLES_CAPABILITY],
    });
  }
  if (path === "/settings/features") {
    if (request.method === "PATCH") {
      const patch = (await request.json()) as Partial<Record<FeatureKey, boolean>>;
      for (const key of featureKeys) {
        if (key in patch) accountOn = patch[key] === true;
      }
    }
    return json(tenantFeatures());
  }
  if (path === `/plans/${profileId}/features`) {
    if (request.method === "PATCH") {
      const patch = (await request.json()) as Partial<Record<FeatureKey, boolean | null>>;
      planOverrides = { ...planOverrides, ...patch };
    }
    return json(planFeatures());
  }
  if (path === "/printer-send-queue" && request.method === "GET") {
    if (!farmEffectiveOn) return json({ items: [] });
    return json({
      items: [
        {
          id: "q1",
          filename: "plate.gcode",
          artifact_path: "/data/plate.gcode",
          printer_id: "printer-1",
          wait_for_idle: true,
          start: true,
          state: "queued",
          created_at: "2026-10-22T00:00:00Z",
          updated_at: "2026-10-22T00:00:00Z",
          host_name: "Core One",
        },
      ],
    });
  }
  throw new Error(`Unexpected fixture request ${request.method} ${path}`);
};

function AccountCard() {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Account feature toggles</h2>
      <TenantFeaturesSettingsCard engineReady />
    </section>
  );
}

function PlanCard() {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Plan feature overrides</h2>
      <PlanFeaturesCard profileId={profileId} />
    </section>
  );
}

function FarmFixture() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Production send queue</h1>
      <p className="text-sm text-muted-foreground">
        Farm queue UI appears only when the selected Plan&apos;s effective farm choice is on.
      </p>
      <output
        aria-label="Send queue visible"
        className="block text-sm font-medium"
        data-farm-queue-visible="pending"
      />
      <PrinterSendQueuePanel
        profileId={profileId}
        engineReady
        onActiveCountChange={(count) => {
          const marker = document.querySelector<HTMLOutputElement>(
            '[aria-label="Send queue visible"]',
          );
          if (marker) marker.dataset.farmQueueVisible = count > 0 ? "yes" : "no";
        }}
      />
    </main>
  );
}

function Body() {
  if (surface === "account") {
    return (
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <AccountCard />
      </main>
    );
  }
  if (surface === "plan") {
    return (
      <main className="mx-auto max-w-2xl space-y-6 p-6">
        <PlanCard />
      </main>
    );
  }
  if (surface === "farm") return <FarmFixture />;
  return (
    <main className="mx-auto max-w-2xl space-y-8 p-6">
      <h1 className="text-2xl font-semibold">Feature toggles</h1>
      <AccountCard />
      <PlanCard />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
createRoot(root).render(
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <JobProvider>
        <Body />
      </JobProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);
