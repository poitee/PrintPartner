import { z } from "zod";

const label = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} _-]+$/u, "Use letters, numbers, spaces, underscores or hyphens");
export const filenameGroupingSchema = z.object({
  name: label,
  rules: z.array(z.object({
    suffix: z.string().trim().min(1).max(120).regex(/^[^/\\]+$/).refine((value) => value.replace(/\.stl$/i, "").length > 0, "Enter a suffix before .stl"),
    group: label.refine((value) => !["unassigned", "conflict"].includes(value.toLowerCase()), "This group name is reserved"),
  }).strict()).max(50),
  overrides: z.record(z.string().max(2048), label.refine((value) => value.toLowerCase() !== "conflict", "Conflict is not an assignment")).default({}),
}).strict().superRefine((value, ctx) => {
  const folders = new Map<string, string>([["unassigned", "Unassigned"]]);
  for (const name of [...value.rules.map((rule) => rule.group), ...Object.values(value.overrides)]) {
    const folder = name.replace(/[^\w\-.]+/g, "_").toLowerCase();
    const previous = folders.get(folder);
    if (previous && previous !== name) ctx.addIssue({ code: "custom", message: `Group names ${previous} and ${name} produce the same export folder` });
    folders.set(folder, name);
  }
});
export type FilenameGrouping = z.infer<typeof filenameGroupingSchema>;
export const filenameExportSchema = z.object({
  definition: filenameGroupingSchema,
  arrangement: z.enum(["group", "color_group", "group_color"]),
  group: z.string().trim().max(80).optional(),
  role: z.string().trim().max(80).optional(),
}).strict();
export type FilenameExport = z.infer<typeof filenameExportSchema>;

export const miloFilenameGrouping: FilenameGrouping = {
  name: "Print settings",
  rules: [
    { suffix: "-A", group: "Aesthetic" },
    { suffix: "-SS", group: "Semi-structural" },
    { suffix: "-S", group: "Structural" },
  ],
  overrides: {},
};

export function filenameGroupKey(sourceLayer: string, relativePath: string): string {
  return JSON.stringify([sourceLayer, relativePath]);
}

export function matchFilenameGroup(definition: FilenameGrouping, relativePath: string, sourceLayer: string): string {
  const override = definition.overrides[filenameGroupKey(sourceLayer, relativePath)];
  if (override) return override.trim();
  const stem = (relativePath.split(/[\\/]/).pop() ?? "").replace(/\.stl$/i, "").toLowerCase();
  const groups = new Set(definition.rules.filter((rule) =>
    stem.endsWith(rule.suffix.trim().replace(/\.stl$/i, "").toLowerCase()),
  ).map((rule) => rule.group.trim()));
  if (groups.size > 1) return "Conflict";
  return [...groups][0] ?? "Unassigned";
}
