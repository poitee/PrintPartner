import { afterEach, describe, expect, it, vi } from "vitest";

class TestSocket {
  static readonly connections: TestSocket[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn(() => this.onclose?.());

  constructor(readonly url: string) { TestSocket.connections.push(this); }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  TestSocket.connections.length = 0;
});

async function connection() {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubEnv("VITE_API_URL", "https://example.test/reverse");
  vi.stubEnv("VITE_API_PREFIX", "/api/v2");
  const { connectJobWebSocket } = await import("./jobWebSocket");
  const onEvent = vi.fn();
  const onError = vi.fn();
  const disconnect = connectJobWebSocket("one", onEvent, onError);
  const socket = TestSocket.connections[0];
  if (!socket) throw new Error("Missing job socket");
  return { socket, disconnect, onEvent, onError };
}

describe("job stream observation lifetime", () => {
  it("uses the browser origin when no API base is configured", async () => {
    vi.stubGlobal("WebSocket", TestSocket);
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:18765" } });
    vi.stubEnv("VITE_API_URL", "");
    vi.stubEnv("VITE_API_PREFIX", "/api/v2");
    const { connectJobWebSocket } = await import("./jobWebSocket");
    const disconnect = connectJobWebSocket("one", () => undefined, () => undefined);
    expect(TestSocket.connections[0]?.url).toBe("ws://127.0.0.1:18765/ws/jobs/one");
    disconnect();
  });

  it("retains a configured reverse-proxy base without applying the REST version prefix", async () => {
    const { socket, disconnect } = await connection();
    expect(socket.url).toBe("wss://example.test/reverse/ws/jobs/one");
    disconnect();
  });

  it("cancels a pending reconnect when the observer disconnects", async () => {
    const { socket, disconnect, onEvent } = await connection();
    socket.onclose?.();
    disconnect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(TestSocket.connections).toHaveLength(1);
    socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      status: "running", message: "Late", progress: 50, result: null, error: null,
    }) }));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("does not reconnect after terminal completion", async () => {
    const { socket, onEvent, disconnect } = await connection();
    const completed = { status: "done", message: "Complete", progress: 100, result: {}, error: null };
    socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(completed) }));
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(completed);
    expect(TestSocket.connections).toHaveLength(1);
    disconnect();
  });

  it.each(["done", "error", "cancelled"])("disposes a %s stream even when its consumer throws", async (status) => {
    const { socket, onEvent, onError } = await connection();
    const failure = new Error("Consumer failed");
    onEvent.mockImplementationOnce(() => { throw failure; });
    const terminal = { status, message: "Finished", progress: null, result: null, error: null };
    socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify(terminal) }));
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    socket.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      ...terminal, status: "running", message: "Late", progress: 50,
    }) }));
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(terminal);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(TestSocket.connections).toHaveLength(1);
  });

  it("bounds retry delay when connections repeatedly fail before a snapshot", async () => {
    const { socket, disconnect } = await connection();
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(499);
    expect(TestSocket.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(TestSocket.connections).toHaveLength(2);
    for (let attempt = 0; attempt < 6; attempt++) {
      TestSocket.connections.at(-1)?.onclose?.();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(TestSocket.connections).toHaveLength(attempt + 3);
    }
    disconnect();
  });

  it("rejects malformed frames without sending them to the job provider", async () => {
    const { socket, disconnect, onEvent, onError } = await connection();
    socket.onmessage?.(new MessageEvent("message", { data: "{}" }));
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Job event stream returned an invalid event" }));
    disconnect();
  });
});
