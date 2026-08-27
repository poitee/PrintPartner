import type { JobEvent } from "@print-partner/contracts";
import { getEngineBaseUrl, resolveEngineUrl } from "./contractRequest";

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

  try {
    const base = getEngineBaseUrl();
    const origin = base || (typeof window === "undefined" ? "" : window.location.origin.replace(/\/$/, ""));
    const httpUrl = resolveEngineUrl(`/jobs/${jobId}/events`);
    const url = new URL(httpUrl, origin || "http://localhost");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (!closed) {
      socket = new WebSocket(url.toString());
      socket.onmessage = (event) => {
        try {
          const value: unknown = JSON.parse(String(event.data));
          if (!isJobEvent(value)) {
            throw new Error("Job event stream returned an invalid event");
          }
          onEvent(value);
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      };
      socket.onerror = () => onError(new Error("Job event stream failed"));
    }
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  }

  return () => {
    closed = true;
    socket?.close();
  };
}
