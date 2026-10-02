import type { JobEvent } from "@print-partner/contracts";
import { getEngineBaseUrl } from "./contractRequest";

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
    onError(error instanceof Error ? error : new Error(String(error)));
    return () => undefined;
  }

  function disconnect() {
    closed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    socket?.close();
  }

  function reconnect() {
    if (closed) return;
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10_000);
  }

  function connect() {
    retryTimer = null;
    if (closed) return;
    try {
      const current = new WebSocket(url.toString());
      socket = current;
      current.onmessage = (event) => {
        if (closed || socket !== current) return;
        try {
          const value: unknown = JSON.parse(String(event.data));
          if (!isJobEvent(value)) {
            throw new Error("Job event stream returned an invalid event");
          }
          retryDelay = 500;
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
      current.onclose = () => {
        if (closed || socket !== current) return;
        socket = null;
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
