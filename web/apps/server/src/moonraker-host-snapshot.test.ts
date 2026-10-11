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
});
