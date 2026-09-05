import * as Sentry from "@sentry/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeReleaseIdentity } from "../lib/version.js";
import {
  initializePrinterErrorReporting,
  reportPrinterFailure,
  shutdownPrinterErrorReporting,
} from "./printer-error-reporting.js";

vi.mock("@sentry/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/node")>();
  return { ...actual, makeNodeTransport: vi.fn(), init: vi.fn(actual.init) };
});

type Transport = ReturnType<typeof Sentry.makeNodeTransport>;
const send = vi.fn<Transport["send"]>();
const flush = vi.fn<Transport["flush"]>();
const config = {
  printerErrorReporting: {
    enabled: true,
    dsn: "https://publickey@o123.ingest.sentry.io/456",
    environment: "test",
  },
  releaseIdentity: resolveRuntimeReleaseIdentity({
    packageVersion: "3.3.0",
    deployMode: "self-host",
    env: { PP_COMMIT: "a".repeat(40), PP_TAG: "v3.3.0" },
  }),
};

beforeEach(() => {
  send.mockReset().mockResolvedValue({});
  flush.mockReset().mockResolvedValue(true);
  vi.mocked(Sentry.makeNodeTransport).mockReset().mockReturnValue({ send, flush });
  vi.mocked(Sentry.init).mockClear();
});

afterEach(async () => {
  await shutdownPrinterErrorReporting();
  Sentry.getGlobalScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.getCurrentScope().clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("printer error reporting", () => {
  it.each([
    { enabled: false, dsn: config.printerErrorReporting.dsn },
    { enabled: true, dsn: null },
    { enabled: true, dsn: "" },
    { enabled: true, dsn: "not-a-dsn-with-private-data" },
  ])("does not initialize or send without valid opt-in configuration: %o", (settings) => {
    expect(initializePrinterErrorReporting({
      ...config,
      printerErrorReporting: { ...config.printerErrorReporting, ...settings },
    })).toBe(false);

    reportPrinterFailure({ operation: "browse", failure: "timeout" });

    expect(Sentry.init).not.toHaveBeenCalled();
    expect(Sentry.makeNodeTransport).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends only approved fields even when SDK scopes contain private data", async () => {
    expect(initializePrinterErrorReporting(config)).toBe(true);
    const secret = "PRIVATE-printer-password-filename.bgcode";
    Sentry.getGlobalScope().setUser({ email: secret, ip_address: "192.168.1.10" });
    Sentry.getGlobalScope().setTag("printer_name", secret);
    Sentry.getIsolationScope().setContext("request", { headers: { authorization: secret } });
    Sentry.getCurrentScope().setExtra("config", { url: `http://${secret}` });
    Sentry.getCurrentScope().addBreadcrumb({ message: secret });
    Sentry.getCurrentScope().addAttachment({ filename: secret, data: secret });
    Sentry.getCurrentScope().addEventProcessor((event) => ({
      ...event,
      message: secret,
      request: { url: `http://192.168.1.10/${secret}`, data: secret },
      exception: { values: [{ value: secret }] },
      server_name: secret,
      release: secret,
      environment: secret,
    }));

    reportPrinterFailure({
      operation: "download",
      failure: "stream_interrupted",
      status: 200,
      headersSent: true,
    });
    await shutdownPrinterErrorReporting();

    expect(send).toHaveBeenCalledOnce();
    const envelope = send.mock.calls[0]?.[0];
    expect(envelope?.[1]).toHaveLength(1);
    expect(envelope?.[1][0]?.[0]).toEqual({ type: "event" });
    expect(envelope?.[1][0]?.[1]).toEqual({
      type: undefined,
      event_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      timestamp: expect.any(Number),
      platform: "node",
      level: "error",
      message: "Printer file download failed",
      release: `print-partner@3.3.0+${"a".repeat(40)}`,
      environment: "test",
      fingerprint: ["printer-file", "download", "stream_interrupted"],
      tags: {
        operation: "download",
        failure: "stream_interrupted",
        http_status: 200,
        headers_sent: true,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(JSON.stringify(envelope)).not.toContain("192.168.");
    expect(JSON.stringify(envelope)).not.toContain("publickey");
  });

  it("disables automatic collection and rejects unrelated SDK events", async () => {
    initializePrinterErrorReporting(config);
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({
      defaultIntegrations: false,
      integrations: [],
      skipOpenTelemetrySetup: true,
      registerEsmLoaderHooks: false,
      maxBreadcrumbs: 0,
      enableLogs: false,
      enableMetrics: false,
      sendClientReports: false,
      tracesSampleRate: 0,
      profileSessionSampleRate: 0,
      tracePropagationTargets: [],
      includeServerName: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
        graphQL: { document: false, variables: false },
        databaseQueryData: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
    }));

    Sentry.captureException(new Error("PRIVATE unrelated failure"));
    Sentry.getClient()?.captureException(new Error("PRIVATE internal SDK failure"), {
      data: { __sentry__: true },
    });
    await shutdownPrinterErrorReporting();

    expect(send).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])("does not affect callers when transport fails by %s", async (mode) => {
    initializePrinterErrorReporting(config);
    if (mode === "throw") send.mockImplementation(() => { throw new Error("PRIVATE transport"); });
    else send.mockRejectedValue(new Error("PRIVATE transport"));

    expect(() => reportPrinterFailure({ operation: "inspect", failure: "upstream_error", status: 502 })).not.toThrow();
    await expect(shutdownPrinterErrorReporting()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps reporting disabled if SDK initialization throws", () => {
    vi.mocked(Sentry.makeNodeTransport).mockImplementation(() => { throw new Error("PRIVATE init"); });

    expect(initializePrinterErrorReporting(config)).toBe(false);
    expect(() => reportPrinterFailure({ operation: "browse", failure: "timeout" })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not affect callers when SDK event capture throws", () => {
    initializePrinterErrorReporting(config);
    const client = Sentry.getClient();
    if (!client) throw new Error("Test reporter did not initialize");
    vi.spyOn(client, "captureEvent").mockImplementation(() => { throw new Error("PRIVATE capture"); });

    expect(() => reportPrinterFailure({ operation: "browse", failure: "timeout" })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds shutdown even if a transport never finishes flushing", async () => {
    vi.useFakeTimers();
    flush.mockImplementation(() => new Promise(() => {}));
    initializePrinterErrorReporting(config);

    const closed = shutdownPrinterErrorReporting();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(closed).resolves.toBeUndefined();
    expect(() => reportPrinterFailure({ operation: "browse", failure: "timeout" })).not.toThrow();
  });
});
