// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TENANT_FEATURE_TOGGLES_CAPABILITY, type PlanFeatures } from "@print-partner/contracts";
import { queryKeys } from "../../queries/keys";
import { useBambuWorkflowAccess } from "../../hooks/useBambuWorkflowAccess";
import { parseSlicedObjectsFile, type ParseSlicedObjectsResult } from "../../lib/parseSlicedObjects";
import { bambuConnectDownloadUrl, startBambuConnectHandoff } from "../../api/endpoints/productionSend";
import PrinterSendPanel from "./PrinterSendPanel";
import { useProductionSendFleet } from "./useProductionSendFleet";

vi.mock("../../hooks/useJobRunner", () => ({ useJobRunner: () => ({ busy: false, runJob: vi.fn() }) }));
vi.mock("../../lib/parseSlicedObjects", () => ({ parseSlicedObjectsFile: vi.fn() }));
vi.mock("../../api/endpoints/productionSend", () => ({
  startBambuConnectHandoff: vi.fn(), startPrinterUpload: vi.fn(), bambuConnectDownloadUrl: vi.fn(),
}));

const parsed: ParseSlicedObjectsResult = { names: [], objects: [], format: "gcode", unlabeled: true };
let client: QueryClient;
let capabilities: string[];
let accountEnabled: boolean;
let planEnabled: boolean;
let planFailure: boolean;
let planPending: boolean;
let healthFailure: boolean;
let requests: string[];

function features(id: number, enabled: boolean): PlanFeatures {
  return { profile_id: id, overrides: { bambu: enabled }, effective: {
    farm: { enabled: false, source: "default" }, orders: { enabled: false, source: "default" },
    bambu: { enabled, source: "plan" }, spoolman: { enabled: false, source: "default" },
  } };
}

function Counts({ profileId }: { profileId: number }) {
  const { data } = useProductionSendFleet({ profileId, enabled: true });
  return <output aria-label="Send destinations">{data?.sendCount ?? 0}</output>;
}

function view(profileId = 1) {
  return <QueryClientProvider client={client}><MemoryRouter>
    <Counts profileId={profileId} />
    <PrinterSendPanel key={profileId} profileId={profileId} planName={`Build ${profileId}`} remainingParts={[]} engineReady />
  </MemoryRouter></QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  capabilities = [TENANT_FEATURE_TOGGLES_CAPABILITY];
  accountEnabled = false;
  planEnabled = false;
  planFailure = false;
  planPending = false;
  healthFailure = false;
  requests = [];
  sessionStorage.clear();
  vi.mocked(parseSlicedObjectsFile).mockReset().mockResolvedValue(parsed);
  vi.mocked(startBambuConnectHandoff).mockReset();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost").pathname;
    requests.push(path);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (path === "/health") return json(healthFailure ? {} : { ok: true, version: "test", data_dir: "test", deploy_mode: "self-host", capabilities }, healthFailure ? 500 : 200);
    if (/^\/plans\/\d+\/features$/.test(path)) {
      if (planPending) return new Promise<Response>(() => {});
      return json(features(Number(path.split("/")[2]), planEnabled), planFailure ? 500 : 200);
    }
    if (path === "/settings/features") return json({ choices: { bambu: accountEnabled }, effective: features(1, accountEnabled).effective });
    if (path === "/printers") return json({ printers: [
      { id: "bambu", name: "Bambu", model: "X1", integration_id: "bambu-host", bed_width_mm: 256, bed_depth_mm: 256, bed_height_mm: 256, margin_mm: 4, max_filament_slots: 1, loaded_filaments: [] },
      { id: "voron", name: "Voron", model: "2.4", integration_id: "moon-host", bed_width_mm: 300, bed_depth_mm: 300, bed_height_mm: 300, margin_mm: 4, max_filament_slots: 1, loaded_filaments: [] },
    ] });
    if (path === "/api/v1/integrations") return json({ integrations: [
      { id: "bambu-host", name: "Bambu", type: "bambu", config: {} },
      { id: "moon-host", name: "Voron", type: "moonraker", config: {} },
    ] });
    if (path.endsWith("/status")) return json({ state: "idle" });
    throw new Error(`Unexpected request ${path}`);
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([
  [false, false], [true, false], [false, true], [true, true],
])("Plan Bambu %s and account Bambu %s govern handoff and status separately", async (plan, account) => {
  planEnabled = plan;
  accountEnabled = account;
  render(view());
  await waitFor(() => expect(screen.getByLabelText("Send destinations").textContent).toBe(plan ? "2" : "1"));
  await waitFor(() => expect(requests).toContain("/api/v1/integrations/moon-host/status"));
  expect(Boolean(screen.queryByRole("button", { name: "Open in Bambu Connect" }))).toBe(plan);
  expect(requests.includes("/api/v1/integrations/bambu-host/status")).toBe(plan && account);
  expect(screen.getByRole("button", { name: "Send" }).textContent).toContain("Send");
  if (plan && !account) expect(screen.getByRole("option", { name: "Bambu · Bambu" }).textContent).toBe("Bambu · Bambu");
});

it("preserves legacy visibility and polling without feature requests", async () => {
  capabilities = [];
  render(view());
  await screen.findByRole("button", { name: "Open in Bambu Connect" });
  await waitFor(() => expect(requests).toContain("/api/v1/integrations/bambu-host/status"));
  expect(screen.getByLabelText("Send destinations").textContent).toBe("2");
  expect(requests.filter((path) => path.endsWith("/features"))).toEqual([]);
});

it.each(["pending", "error", "health"])("hides Bambu while %s without hiding direct-send printers", async (state) => {
  planPending = state === "pending";
  planFailure = state === "error";
  healthFailure = state === "health";
  render(view());
  await screen.findByRole("button", { name: "Send" });
  expect(screen.queryByRole("button", { name: "Open in Bambu Connect" })).toBeNull();
  expect(screen.getByLabelText("Send destinations").textContent).toBe("1");
  expect(requests.includes("/api/v1/integrations/bambu-host/status")).toBe(false);
});

it("uses live Plan cache updates and fails closed when a refetch errors over allowed data", async () => {
  render(view());
  await screen.findByRole("button", { name: "Send" });
  await act(async () => { client.setQueryData(queryKeys.planFeatures(1), features(1, true)); });
  await screen.findByRole("button", { name: "Open in Bambu Connect" });
  expect(screen.getByLabelText("Send destinations").textContent).toBe("2");
  planFailure = true;
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.planFeatures(1) }); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Open in Bambu Connect" })).toBeNull());
  expect(screen.getByLabelText("Send destinations").textContent).toBe("1");
});

it.each(["revoke", "switch", "off-on"])("does not dispatch a file after %s during parsing", async (change) => {
  planEnabled = true;
  let finish: (value: ParseSlicedObjectsResult) => void = () => {};
  vi.mocked(parseSlicedObjectsFile).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const rendered = render(view());
  await screen.findByRole("button", { name: "Open in Bambu Connect" });
  const input = rendered.container.querySelector<HTMLInputElement>('input[accept^=".3mf"]');
  if (!input) throw new Error("Missing Bambu file input");
  fireEvent.change(input, { target: { files: [new File(["G28"], "test.gcode")] } });
  expect(parseSlicedObjectsFile).toHaveBeenCalledTimes(1);
  if (change === "switch") rendered.rerender(view(2));
  else await act(async () => {
    client.setQueryData(queryKeys.planFeatures(1), features(1, false));
    if (change === "off-on") client.setQueryData(queryKeys.planFeatures(1), features(1, true));
  });
  await act(async () => { finish(parsed); });
  expect(startBambuConnectHandoff).not.toHaveBeenCalled();
  if (change !== "revoke") {
    await screen.findByRole("button", { name: "Open in Bambu Connect" });
    const nextInput = rendered.container.querySelector<HTMLInputElement>('input[accept^=".3mf"]');
    if (!nextInput) throw new Error("Missing enabled Bambu input");
    vi.mocked(startBambuConnectHandoff).mockRejectedValueOnce(new Error("Test handoff reached"));
    fireEvent.change(nextInput, { target: { files: [new File(["G28"], "next.gcode")] } });
    await waitFor(() => expect(startBambuConnectHandoff).toHaveBeenCalledWith(expect.objectContaining({ profile_id: change === "switch" ? 2 : 1, printer_id: "bambu" })));
  }
});

it("invalidates retained attempts synchronously before React rerenders", async () => {
  planEnabled = true;
  const { result } = renderHook(() => useBambuWorkflowAccess({ profileId: 1, engineReady: true }), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.canHandoff).toBe(true));
  const attempt = result.current.beginHandoff();
  expect(attempt?.isCurrent()).toBe(true);
  act(() => {
    client.setQueryData(queryKeys.planFeatures(1), features(1, false));
    client.setQueryData(queryKeys.planFeatures(1), features(1, true));
    expect(attempt?.isCurrent()).toBe(false);
  });
  expect(result.current.beginHandoff()?.isCurrent()).toBe(true);
});

it.each([false, true])("suppresses a late handoff download only when revoked=%s", async (revoke) => {
  planEnabled = true;
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  vi.mocked(bambuConnectDownloadUrl).mockReturnValue("http://localhost/download/test");
  let finish: (value: Awaited<ReturnType<typeof startBambuConnectHandoff>>) => void = () => {};
  vi.mocked(startBambuConnectHandoff).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const rendered = render(view());
  await screen.findByRole("button", { name: "Open in Bambu Connect" });
  const input = rendered.container.querySelector<HTMLInputElement>('input[accept^=".3mf"]');
  if (!input) throw new Error("Missing Bambu file input");
  fireEvent.change(input, { target: { files: [new File(["G28"], "test.gcode")] } });
  await waitFor(() => expect(startBambuConnectHandoff).toHaveBeenCalledWith(expect.objectContaining({ profile_id: 1, printer_id: "bambu" })));
  if (revoke) act(() => { client.setQueryData(queryKeys.planFeatures(1), features(1, false)); });
  await act(async () => { finish({ handoff_id: "test", filename: "test.gcode", absolute_path: "/staged/test.gcode",
    connect_url: "bambu-connect://test", launched: false, in_container: true, download_path: "/download/test", message: "Test handoff" }); });
  expect(open.mock.calls).toEqual(revoke ? [] : [["http://localhost/download/test", "_blank"]]);
});
