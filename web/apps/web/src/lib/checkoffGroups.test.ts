import { expect, it } from "vitest";
import type { ReviewPart } from "../api/endpoints/planManifests";
import { groupCheckoffParts } from "./checkoffGroups";
import { parseCheckoffConsolePreferences, serializeCheckoffConsolePreferences } from "./checkoffConsolePreferences";

function part(id: number, source: string, path: string): ReviewPart {
  return {
    id, source_layer: source, relative_path: path, filename: path.split("/").at(-1) ?? path,
    match_key: path, status: "ok", role: "primary", requirement: null, option_group_id: null,
    included: true, filament_color_id: null, filament_display: "", quantity_auto: 1,
    quantity_override: null, quantity_effective: 1, printed_count: 0, print_units: [false], missing: true,
  };
}

const parts = [part(1, "addon:Tools", "Z/part10.stl"), part(2, "base:Kit", "Z/part2.stl"), part(3, "addon:Tools", "A/part1.stl")];
const ids = (sort: "source" | "directory") => groupCheckoffParts(parts, sort).flatMap((group) => group.folders.flatMap((folder) => folder.parts.map((p) => p.id)));

it("sorts by source or directory without changing input or print progress", () => {
  const before = structuredClone(parts);
  expect(ids("source")).toEqual([2, 3, 1]);
  expect(ids("directory")).toEqual([3, 2, 1]);
  expect(parts).toEqual(before);
  expect(groupCheckoffParts(parts, "directory").map((group) => group.repoLabel)).toEqual(["A", "Z"]);
});

it("uses natural filename ordering within a directory", () => {
  const groups = groupCheckoffParts([part(1, "base:Kit", "A/part10.stl"), part(2, "base:Kit", "A/part2.stl")]);
  expect(groups[0]?.folders[0]?.parts.map((p) => p.id)).toEqual([2, 1]);
});

it.each(["manual", "source", "directory"])("persists %s sorting and rejects unknown modes", (sort) => {
  const prefs = parseCheckoffConsolePreferences(JSON.stringify({ sort }));
  expect(parseCheckoffConsolePreferences(serializeCheckoffConsolePreferences(prefs)).sort).toBe(sort);
  expect(parseCheckoffConsolePreferences('{"sort":"invalid"}').sort).toBeUndefined();
});
