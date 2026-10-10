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
it("ticket_t_4 Moonraker host budget still rejects oversized snapshots", () => {
  const hosts = Array.from({ length: 128 }, (_, id) => ({ id, type: "moonraker" }));
  expect(moonrakerHostSnapshot(JSON.stringify(hosts))).toHaveLength(128);
  expect(moonrakerHostSnapshot(JSON.stringify([...hosts, hosts[0]]))).toBeNull();
  expect(moonrakerHostSnapshot('{}')).toBeNull();
});
