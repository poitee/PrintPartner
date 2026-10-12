import { expect, it } from "vitest";
import { moonrakerHostSnapshot } from "./moonraker-host-snapshot.js";

it("ticket_t_4 unrelated integrations do not disable a bounded Moonraker snapshot", () => {
  const other = Array.from({ length: 129 }, (_, id) => ({ id, type: "spoolman" }));
  const host = { id: "printer", type: "moonraker", config: { baseUrl: "http://printer", apiKey: "test", enabled: false } };
  expect(moonrakerHostSnapshot(JSON.stringify([...other, null, host]))).toEqual([
    { id: "printer", base_url: "http://printer", api_key: "test", enabled: false },
  ]);
  expect(moonrakerHostSnapshot(JSON.stringify(other))).toEqual([]);
});
it("ticket_t_4 Moonraker host budget sends ids only past the cap", () => {
  const hosts = Array.from({ length: 128 }, (_, id) => ({
    id,
    type: "moonraker",
    config: { base_url: "http://printer", api_key: "secret" },
  }));
  expect(moonrakerHostSnapshot(JSON.stringify(hosts))).toHaveLength(128);
  const over = moonrakerHostSnapshot(JSON.stringify([...hosts, { ...hosts[0], id: 128 }]));
  expect(over).toHaveLength(129);
  expect(over?.[128]).toEqual({ id: "128", base_url: "", api_key: null, enabled: false });
  expect(over?.every((host) => host.base_url === "" && host.api_key === null)).toBe(true);
  expect(moonrakerHostSnapshot('{}')).toBeNull();
  expect(moonrakerHostSnapshot("{")).toBeNull();
  expect(moonrakerHostSnapshot("")).toEqual([]);
});
it("projects an oversized Moonraker row before the snapshot is serialized", () => {
  const healthy = { id: "ok", type: "moonraker", config: { base_url: "http://printer", api_key: "secret" } };
  const maxUrl = { id: "max", type: "moonraker", config: { base_url: "h".repeat(4096), api_key: "k" } };
  const hugeUrl = { id: "big", type: "moonraker", config: { base_url: "h".repeat(4097), api_key: "secret" } };
  const hugeKey = { id: "key", type: "moonraker", config: { base_url: "http://printer", api_key: "k".repeat(4097) } };
  const wide = { id: "wide", type: "moonraker", config: { base_url: "é".repeat(2049), api_key: "k" } };
  expect(moonrakerHostSnapshot(JSON.stringify([healthy, maxUrl, hugeUrl, hugeKey, wide]))).toEqual([
    { id: "ok", base_url: "http://printer", api_key: "secret", enabled: true },
    { id: "max", base_url: "h".repeat(4096), api_key: "k", enabled: true },
    { id: "big", base_url: "", api_key: null, enabled: false },
    { id: "key", base_url: "", api_key: null, enabled: false },
    { id: "wide", base_url: "", api_key: null, enabled: false },
  ]);
});
