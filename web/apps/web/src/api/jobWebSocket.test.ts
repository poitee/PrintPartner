import { afterEach, describe, expect, it, vi } from "vitest";

class TestSocket {
  static readonly connections: TestSocket[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: Pick<CloseEvent, "code" | "reason">) => void) | null = null;
  close = vi.fn(() => this.onclose?.({ code: 1000, reason: "" }));

  constructor(readonly url: string) { TestSocket.connections.push(this); }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  TestSocket.connections.length = 0;
});

async function connection() {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
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
    socket.onclose?.({ code: 1006, reason: "" });
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
    socket.onclose?.({ code: 1006, reason: "" });
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
    socket.onclose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith(terminal);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(TestSocket.connections).toHaveLength(1);
  });

  it("bounds retry delay when connections repeatedly fail before a snapshot", async () => {
    const { socket, disconnect } = await connection();
    socket.onclose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(499);
    expect(TestSocket.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(TestSocket.connections).toHaveLength(2);
    for (let attempt = 0; attempt < 6; attempt++) {
      TestSocket.connections.at(-1)?.onclose?.({ code: 1006, reason: "" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(TestSocket.connections).toHaveLength(attempt + 3);
    }
    disconnect();
  });

  it("stops retrying a missing job and reports its clear terminal state", async () => {
    const { socket, onError, onEvent } = await connection();
    socket.onclose?.({ code: 1008, reason: "Job not found" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(TestSocket.connections).toHaveLength(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "Job not found" }));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each([1000, 1001, 1008, 1002, 1003])("does not retry a non-transient close %s", async (code) => {
    const { socket, disconnect } = await connection();
    socket.onclose?.({ code, reason: "" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(TestSocket.connections).toHaveLength(1);
    disconnect();
  });

  it("jitters exponential retries and caps their actual delay", async () => {
    const { socket, disconnect } = await connection();
    vi.mocked(Math.random).mockReturnValue(0);
    socket.onclose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(399);
    expect(TestSocket.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(TestSocket.connections).toHaveLength(2);
    vi.mocked(Math.random).mockReturnValue(1);
    TestSocket.connections.at(-1)?.onclose?.({ code: 1013, reason: "" });
    await vi.advanceTimersByTimeAsync(1199);
    expect(TestSocket.connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(TestSocket.connections).toHaveLength(3);
    for (let i = 0; i < 6; i++) {
      TestSocket.connections.at(-1)?.onclose?.({ code: 1011, reason: "" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(TestSocket.connections).toHaveLength(i + 4);
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
