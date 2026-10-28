import type { JobEvent } from "@print-partner/contracts";
import { getEngineBaseUrl } from "./contractRequest";

export class JobNotFoundError extends Error {
  constructor() {
    super("Job not found");
    this.name = "JobNotFoundError";
  }
}

/** A 1008 close other than `Job not found`. The socket does not reconnect. */
export class JobSocketClosedError extends Error {
  constructor(readonly reason: string) {
    super(reason.length > 0 ? reason : "Job socket closed");
    this.name = "JobSocketClosedError";
  }
}

/** The job socket URL could not be built. Nothing is connected. */
export class JobSocketSetupError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "JobSocketSetupError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobEvent(value: unknown): value is JobEvent {
  if (!isRecord(value)) return false;
  const progress = value.progress;
  const result = value.result;
  const error = value.error;
  return (
    typeof value.status === "string" &&
    typeof value.message === "string" &&
    (progress === null || typeof progress === "number") &&
    (result === null || isRecord(result)) &&
    (error === null || typeof error === "string")
  );
}

export function connectJobWebSocket(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  onError: (error: Error) => void,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 500;
  let url: URL;

  try {
    const base = getEngineBaseUrl();
    const origin = base || (typeof window === "undefined" ? "" : window.location.origin.replace(/\/$/, ""));
    url = new URL(`${origin || "http://localhost"}/ws/jobs/${encodeURIComponent(jobId)}`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  } catch (error) {
    onError(new JobSocketSetupError(error));
    return () => undefined;
  }

  function disconnect() {
    closed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    socket?.close();
  }

  function reconnect() {
    if (closed) return;
    const delay = Math.min(retryDelay * (0.8 + Math.random() * 0.4), 10_000);
    retryTimer = setTimeout(connect, delay);
    retryDelay = Math.min(retryDelay * 2, 10_000);
  }

  function connect() {
    retryTimer = null;
    if (closed) return;
    try {
      const current = new WebSocket(url.toString());
      socket = current;
      current.onopen = () => {
        if (!closed && socket === current) retryDelay = 500;
      };
      current.onmessage = (event) => {
        if (closed || socket !== current) return;
        try {
          const value: unknown = JSON.parse(String(event.data));
          if (!isJobEvent(value)) {
            throw new Error("Job event stream returned an invalid event");
          }
          if (value.status === "done" || value.status === "error" || value.status === "cancelled") {
            disconnect();
          }
          onEvent(value);
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      };
      current.onerror = () => {
        if (!closed && socket === current) onError(new Error("Job event stream failed"));
      };
      current.onclose = (event) => {
        if (closed || socket !== current) return;
        socket = null;
        if (event.code === 1008 && event.reason === "Job not found") {
          closed = true;
          onError(new JobNotFoundError());
          return;
        }
        // A 1008 close will not reconnect. Report it once, including session
        // expiry. Every other close can be a restart, including a no-code
        // shutdown, code 1005 in the browser.
        if (event.code === 1008) {
          closed = true;
          onError(new JobSocketClosedError(event.reason));
          return;
        }
        reconnect();
      };
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      reconnect();
    }
  }

  connect();
  return disconnect;
}
