import mqtt, { type IClientOptions, type MqttClient, type OnMessageCallback } from "mqtt";
import { isIP } from "node:net";
import type {
  DeviceSummary,
  IntegrationConfig,
  IntegrationTestResult,
  PrinterHostStatus,
} from "@print-partner/contracts";
import type { IntegrationAdapter } from "../store.js";
import {
  assertSafeOutboundHost,
  classifyAddress,
  OutboundUrlError,
} from "../../lib/outbound-url.js";

const DEFAULT_PORT = 8883;
const MQTT_USERNAME = "bblp";
const CONNECT_TIMEOUT_MS = 8_000;
const STATUS_TIMEOUT_MS = 10_000;

export type BambuMqttConnect = (
  brokerUrl: string,
  options?: IClientOptions,
) => MqttClient;

let mqttConnect: BambuMqttConnect = (brokerUrl, options) =>
  mqtt.connect(brokerUrl, options);

/** @internal Vitest hook — restore with `null` in afterEach. */
export function setBambuMqttConnectForTests(fn: BambuMqttConnect | null): void {
  mqttConnect = fn ?? ((brokerUrl, options) => mqtt.connect(brokerUrl, options));
}

type BambuPrintReport = {
  command?: string;
  gcode_state?: string;
  mc_percent?: number | string;
  mc_remaining_time?: number | string;
  gcode_file?: string;
  subtask_name?: string;
};

type BambuReportPayload = {
  print?: BambuPrintReport;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readHost(config: IntegrationConfig): string | null {
  return (
    asNonEmptyString(config.host) ??
    asNonEmptyString(config.hostname) ??
    asNonEmptyString(config.ip) ??
    null
  );
}

function readAccessCode(config: IntegrationConfig): string | null {
  const code =
    asNonEmptyString(config.access_code) ?? asNonEmptyString(config.accessCode);
  if (!code || code === "****") return null;
  return code;
}

function readSerial(config: IntegrationConfig): string | null {
  const serial =
    asNonEmptyString(config.serial) ??
    asNonEmptyString(config.device_id) ??
    asNonEmptyString(config.deviceId);
  if (!serial) return null;
  // Reject MQTT topic wildcards / path separators before interpolating topics.
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(serial)) return null;
  return serial;
}

function readPort(config: IntegrationConfig): number {
  const raw = config.port;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw < 65536) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0 && n < 65536) return Math.floor(n);
  }
  return DEFAULT_PORT;
}

/** Map Bambu `gcode_state` tokens to Print Partner host states. */
export function mapBambuGcodeState(
  raw: string | undefined,
): PrinterHostStatus["state"] {
  const state = (raw ?? "").trim().toUpperCase();
  if (!state) return "unknown";
  if (state === "IDLE") return "idle";
  if (state === "RUNNING" || state === "PREPARE" || state === "SLICING" || state === "INIT") {
    return "printing";
  }
  if (state === "PAUSE") return "paused";
  if (state === "FINISH") return "complete";
  if (state === "FAILED") return "error";
  if (state === "OFFLINE") return "offline";
  return "unknown";
}

export function statusFromBambuPrint(print: BambuPrintReport): PrinterHostStatus {
  const gcodeState = print.gcode_state;
  const state = mapBambuGcodeState(gcodeState);
  const percentRaw = print.mc_percent;
  const percentNum =
    typeof percentRaw === "number"
      ? percentRaw
      : typeof percentRaw === "string"
        ? Number(percentRaw)
        : NaN;
  const progress =
    Number.isFinite(percentNum)
      ? Math.round(Math.min(100, Math.max(0, percentNum)))
      : undefined;

  const remainingRaw = print.mc_remaining_time;
  const remainingMinutes =
    typeof remainingRaw === "number"
      ? remainingRaw
      : typeof remainingRaw === "string"
        ? Number(remainingRaw)
        : NaN;
  // Bambu reports remaining time in minutes.
  const eta_seconds =
    Number.isFinite(remainingMinutes) && remainingMinutes > 0
      ? Math.round(remainingMinutes * 60)
      : undefined;

  const filename =
    asNonEmptyString(print.subtask_name) ??
    asNonEmptyString(print.gcode_file) ??
    undefined;

  const showProgress = state === "printing" || state === "paused";
  return {
    state,
    progress: showProgress ? progress : undefined,
    filename,
    eta_seconds: showProgress ? eta_seconds : undefined,
    message:
      state === "printing" && filename
        ? `Printing ${filename}`
        : state === "complete"
          ? filename
            ? `Complete · ${filename}`
            : "Complete"
          : state === "idle"
            ? "Idle"
            : state === "paused"
              ? "Paused"
              : state === "error"
                ? "Error"
                : gcodeState
                  ? `gcode_state: ${gcodeState}`
                  : undefined,
  };
}

function parseReportPayload(raw: string | Buffer): BambuReportPayload | null {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    const parsed = JSON.parse(text) as BambuReportPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isUsablePrintReport(print: BambuPrintReport | undefined): print is BambuPrintReport {
  return Boolean(print && typeof print.gcode_state === "string" && print.gcode_state.trim());
}

type BambuConnection = {
  host: string;
  port: number;
  accessCode: string;
  serial: string;
  /** False only for private IP literals (self-signed printer certs). */
  rejectUnauthorized: boolean;
};

/**
 * Skip TLS verify only for private IP literals.
 * Hostnames always verify — avoids DNS-rebinding races with a second lookup.
 */
export function shouldRejectUnauthorizedTls(hostname: string): boolean {
  if (!isIP(hostname)) return true;
  return classifyAddress(hostname) !== "private";
}

async function resolveConnection(
  config: IntegrationConfig,
): Promise<{ ok: true; conn: BambuConnection } | { ok: false; message: string }> {
  const hostRaw = readHost(config);
  if (!hostRaw) return { ok: false, message: "host (printer LAN IP) is required" };
  const accessCode = readAccessCode(config);
  if (!accessCode) return { ok: false, message: "access_code is required" };
  const serial = readSerial(config);
  if (!serial) {
    const raw =
      asNonEmptyString(config.serial) ??
      asNonEmptyString(config.device_id) ??
      asNonEmptyString(config.deviceId);
    return {
      ok: false,
      message: raw
        ? "serial must be 6–64 letters/digits (no MQTT wildcards or path characters)"
        : "serial (device id) is required",
    };
  }
  const port = readPort(config);

  try {
    const host = await assertSafeOutboundHost(hostRaw, { allowPrivate: true });
    const rejectUnauthorized = shouldRejectUnauthorizedTls(host);
    return { ok: true, conn: { host, port, accessCode, serial, rejectUnauthorized } };
  } catch (e) {
    const message =
      e instanceof OutboundUrlError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return { ok: false, message };
  }
}

function brokerUrl(conn: BambuConnection): string {
  const host = conn.host.includes(":") ? `[${conn.host}]` : conn.host;
  return `mqtts://${host}:${conn.port}`;
}

/**
 * Connect over local MQTT TLS, request `pushall`, and resolve the first
 * report that includes `print.gcode_state`. Status-only — no print control.
 */
function fetchBambuStatus(conn: BambuConnection): Promise<PrinterHostStatus> {
  return new Promise((resolve) => {
    let settled = false;
    let client: MqttClient | null = null;

    const finish = (status: PrinterHostStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep the "error" listener bound (guarded by `settled`) instead of
      // removeAllListeners(): the mqtt client's own internal connect/connack
      // timers can still fire an "error" after we resolve, and an Emitter
      // with zero "error" listeners throws and crashes the process.
      try {
        client?.removeListener("message", onMessage);
        client?.end(true);
      } catch {
        // ignore disconnect errors after we already have a result
      }
      resolve(status);
    };

    const timer = setTimeout(() => {
      finish({
        state: "offline",
        message: "Timed out waiting for Bambu MQTT status (check LAN mode, IP, serial, access code)",
      });
    }, STATUS_TIMEOUT_MS);

    try {
      client = mqttConnect(brokerUrl(conn), {
        username: MQTT_USERNAME,
        password: conn.accessCode,
        protocol: "mqtts",
        port: conn.port,
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectPeriod: 0,
        // LAN printers use self-signed v1 certs; public targets keep verification on.
        rejectUnauthorized: conn.rejectUnauthorized,
        clean: true,
      });
    } catch (e) {
      finish({
        state: "offline",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const reportTopic = `device/${conn.serial}/report`;
    const requestTopic = `device/${conn.serial}/request`;

    const onMessage: OnMessageCallback = (_topic, payload) => {
      const body = parseReportPayload(payload);
      if (!isUsablePrintReport(body?.print)) return;
      finish(statusFromBambuPrint(body.print));
    };

    client.on("message", onMessage);

    client.on("error", (err) => {
      finish({
        state: "offline",
        message: err?.message || "Bambu MQTT connection error",
      });
    });

    client.on("close", () => {
      if (!settled) {
        finish({
          state: "offline",
          message: "Bambu MQTT connection closed (LAN mode off or connection refused?)",
        });
      }
    });

    client.on("connect", () => {
      client!.subscribe(reportTopic, (subErr) => {
        if (subErr) {
          finish({
            state: "offline",
            message: subErr.message || "Failed to subscribe to Bambu report topic",
          });
          return;
        }
        const pushall = JSON.stringify({
          pushing: { sequence_id: "0", command: "pushall" },
        });
        client!.publish(requestTopic, pushall, { qos: 0 }, (pubErr) => {
          if (pubErr) {
            finish({
              state: "offline",
              message: pubErr.message || "Failed to request Bambu pushall status",
            });
          }
        });
      });
    });
  });
}

export const bambuAdapter: IntegrationAdapter = {
  type: "bambu",

  async testConnection(config: IntegrationConfig): Promise<IntegrationTestResult> {
    const resolved = await resolveConnection(config);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    try {
      const status = await fetchBambuStatus(resolved.conn);
      if (status.state === "offline") {
        return { ok: false, message: status.message ?? "Bambu MQTT offline" };
      }
      return {
        ok: true,
        message: `Connected (LAN MQTT · ${status.message ?? status.state})`,
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  async listDevices(config: IntegrationConfig): Promise<DeviceSummary[]> {
    const serial = readSerial(config);
    if (!serial) return [];
    const host = readHost(config);
    return [
      {
        id: serial,
        name: host ? `Bambu @ ${host}` : `Bambu ${serial}`,
        type: "bambu",
        status: "configured",
      },
    ];
  },

  async getStatus(config: IntegrationConfig): Promise<PrinterHostStatus> {
    const resolved = await resolveConnection(config);
    if (!resolved.ok) {
      return { state: "offline", message: resolved.message };
    }
    try {
      return await fetchBambuStatus(resolved.conn);
    } catch (e) {
      return {
        state: "offline",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  },

  // Intentionally no uploadFile: send requires Developer Mode / official Connect-Local Server.
};
