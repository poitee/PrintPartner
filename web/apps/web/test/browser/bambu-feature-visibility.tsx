import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type PlanFeatures } from "@print-partner/contracts";
import { JobProvider } from "../../src/context/JobContext";
import PrinterSendPanel from "../../src/components/export/PrinterSendPanel";
import PlanFeaturesCard from "../../src/components/plan/PlanFeaturesCard";
import { useProductionSendFleet } from "../../src/components/export/useProductionSendFleet";

const params = new URLSearchParams(location.search);
const gated = params.get("gate") !== "0";
const accountEnabled = params.get("account") === "1";
let planEnabled = params.get("plan") === "1";
const requests: string[] = [];
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function features(): PlanFeatures {
  return { profile_id: 1, overrides: { bambu: planEnabled }, effective: {
    farm: { enabled: false, source: "default" }, orders: { enabled: false, source: "default" },
    bambu: { enabled: planEnabled, source: "plan" }, spoolman: { enabled: false, source: "default" },
  } };
}

window.fetch = async (input, init) => {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  requests.push(path);
  document.body.dataset.requests = JSON.stringify(requests);
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  if (path === "/health") return json({ ok: true, version: "fixture", deploy_mode: "self-host", data_dir: "fixture", capabilities: gated ? [TENANT_FEATURE_TOGGLES_CAPABILITY] : [] });
  if (path === "/plans/1/features") {
    if (request.method === "PATCH") {
      const patch: unknown = await request.json();
      if (patch && typeof patch === "object" && "bambu" in patch) planEnabled = patch.bambu === null ? accountEnabled : patch.bambu === true;
    }
    return json(features());
  }
  if (path === "/settings/features") return json({ choices: { bambu: accountEnabled }, effective: { ...features().effective, bambu: { enabled: accountEnabled, source: "user" } } });
  if (path === "/printers") return json({ printers: [
    { id: "bambu", name: "Bambu", model: "X1", integration_id: "bambu-host", bed_width_mm: 256, bed_depth_mm: 256, bed_height_mm: 256, margin_mm: 4, max_filament_slots: 1, loaded_filaments: [] },
    { id: "voron", name: "Voron", model: "2.4", integration_id: "moon-host", bed_width_mm: 300, bed_depth_mm: 300, bed_height_mm: 300, margin_mm: 4, max_filament_slots: 1, loaded_filaments: [] },
  ] });
  if (path === "/api/v1/integrations") return json({ integrations: [
    { id: "bambu-host", name: "Bambu", type: "bambu", config: {} },
    { id: "moon-host", name: "Voron", type: "moonraker", config: {} },
  ] });
  if (path.endsWith("/status")) return json({ state: "idle" });
  throw new Error(`Unexpected fixture request ${request.method} ${path}`);
};

function Fixture() {
  const { data } = useProductionSendFleet({ profileId: 1, enabled: true });
  return <main className="mx-auto max-w-4xl space-y-6 p-6">
    <h1 className="text-2xl font-semibold">Production</h1>
    <p>Build One · <output aria-label="Send destinations">{data?.sendCount ?? 0}</output> send destinations</p>
    <PlanFeaturesCard profileId={1} />
    <PrinterSendPanel profileId={1} planName="Build One" remainingParts={[]} engineReady />
  </main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
createRoot(root).render(
  <QueryClientProvider client={client}><MemoryRouter><JobProvider><Fixture /></JobProvider></MemoryRouter></QueryClientProvider>,
);
