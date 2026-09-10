import { z } from "zod";

const publisherHosts = new Set([
  "github.com", "gitlab.com", "codeberg.org", "printables.com", "www.printables.com",
  "makerworld.com", "www.makerworld.com", "thangs.com", "www.thangs.com",
]);

export function isSharePublisherUrl(value: string): boolean {
  const match = /^https:\/\/([^/]+)(?:\/[^?#\s]*)?$/i.exec(value);
  return match?.[1] != null && publisherHosts.has(match[1].toLowerCase());
}

const text = z.string().max(2000);
const relativePath = text.min(1).refine(
  (value) => !/^[\\/]|^[A-Za-z]:|\\/.test(value) &&
    ![...value].some((character) => character.charCodeAt(0) < 32) &&
    !value.split("/").includes(".."),
  "Use a relative path without traversal or control characters",
);
const sourceKey = z.string().regex(/^source-[1-9]\d*$/);
const source = z.strictObject({
  key: sourceKey,
  name: text,
  location: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("publisher"), url: text.refine(isSharePublisherUrl) }),
    z.strictObject({ kind: z.literal("manual") }),
  ]),
  revision: z.strictObject({
    branch: text.nullable(),
    tag: text.nullable(),
    commit: z.string().regex(/^[a-fA-F0-9]{40,64}$/).nullable(),
  }),
  file_rules: z.array(relativePath).max(10000),
});
const common = {
  format: z.literal("printpartner-reference-share"),
  version: z.literal(1),
  title: text.min(1),
  sources: z.array(source).max(1000),
};
export const referenceShareSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("collection") }),
  z.strictObject({
    ...common,
    kind: z.literal("build"),
    layers: z.array(z.strictObject({ source: sourceKey, role: text })).max(1000),
    selections: z.record(text, z.union([text, z.array(text).max(1000)])),
    include: z.array(relativePath).max(10000),
    exclude: z.array(relativePath).max(10000),
    replacements: z.record(relativePath, relativePath),
    parts: z.array(z.strictObject({
      source: sourceKey,
      path: relativePath,
      quantity: z.number().int().nonnegative().max(1000000),
      included: z.boolean(),
      role: text,
      color: z.string().regex(/^#[a-fA-F0-9]{6}$/).nullable(),
    })).max(100000),
  }),
]).superRefine((manifest, ctx) => {
  const keys = new Set(manifest.sources.map((entry) => entry.key));
  if (keys.size !== manifest.sources.length) ctx.addIssue({ code: "custom", message: "Duplicate source keys" });
  if (manifest.kind === "build") {
    for (const entry of [...manifest.layers, ...manifest.parts]) {
      if (!keys.has(entry.source)) ctx.addIssue({ code: "custom", message: "Unknown source reference" });
    }
  }
});

export type ReferenceShare = z.infer<typeof referenceShareSchema>;
export type ReferenceShareExport = { manifest: ReferenceShare; warnings: string[] };
