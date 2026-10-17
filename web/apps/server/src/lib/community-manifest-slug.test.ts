import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { zipSync } from "fflate";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { buildApp } from "../app.js";
import { applyAssistantAction, invokeAssistantTool } from "../assistant/tools.js";
import { loadConfig } from "../config.js";
import { registerImportRoutes } from "../routes/imports.js";
import { collectKitBundleSourceRefs } from "../services/kit-bundle-share.js";
import {
  INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL,
  InvalidCommunityManifestSlugError,
  parseCommunityManifestSlug,
} from "./community-manifest-slug.js";

const INVALID_SLUGS = [
  "../x",
  "..\\x",
  "/etc/x",
  "C:\\x",
  "%2e%2e%2fx",
  "a\0b",
  "a/b",
  "..",
  "a".repeat(65),
  "kit-catalog",
];
const VALID_SLUGS = ["ldo-2.4-sb-tap", "voron-stealthburner", "example-kit-r2", "a".repeat(64)];
const SOURCE_URL = "https://github.com/a/addon";

function kitBundle(slug: unknown): Record<string, unknown> {
  return {
    format: "print-partner-kit",
    version: 3,
    profile: { name: "Shared" },
    layers: [
      {
        layer_order: 0,
        layer_type: "base",
        project: { name: "Addon", url: SOURCE_URL, manifest_community_slug: slug },
      },
    ],
    parts: [],
  };
}

function kitArchive(slug: unknown): Buffer {
  return Buffer.from(
    zipSync({ "kit.json": Buffer.from(JSON.stringify(kitBundle(slug))) }),
  );
}

describe("parseCommunityManifestSlug", () => {
  it.each(VALID_SLUGS)("accepts %j", (slug) => {
    expect(parseCommunityManifestSlug(` ${slug} `)).toBe(slug);
  });

  it.each([undefined, null, "", "   "])("treats %j as no community manifest", (value) => {
    expect(parseCommunityManifestSlug(value)).toBeNull();
  });

  it.each([...INVALID_SLUGS, "Upper", 7, {}])("rejects %j", (value) => {
    expect(() => parseCommunityManifestSlug(value)).toThrow(InvalidCommunityManifestSlugError);
  });
});

describe("community manifest slug write boundaries", () => {
  let dataDir: string;
  let ports: ReturnType<typeof createSelfHostPorts>;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;
  let sourceId: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-community-slug-"));
    ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;
    sourceId = repo.createSource({ name: "Addon", url: SOURCE_URL }).id;
    repo.updateSource(sourceId, { manifest_community_slug: "ldo-2.4-sb-tap" });
  });

  afterEach(async () => {
    await ports.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const storedSlug = () => repo.getSource(sourceId)?.manifest_community_slug;

  it("updateSource stores valid slugs and clears blank ones", () => {
    repo.updateSource(sourceId, { manifest_community_slug: " voron-stealthburner " });
    expect(storedSlug()).toBe("voron-stealthburner");
    repo.updateSource(sourceId, { manifest_community_slug: "" });
    expect(storedSlug()).toBeNull();
  });

  it.each(INVALID_SLUGS)("updateSource refuses %j", (slug) => {
    expect(() => repo.updateSource(sourceId, { manifest_community_slug: slug })).toThrow(
      InvalidCommunityManifestSlugError,
    );
    expect(storedSlug()).toBe("ldo-2.4-sb-tap");
  });

  it.each(INVALID_SLUGS)("kit bundle parsing refuses %j", (slug) => {
    expect(() => collectKitBundleSourceRefs(kitBundle(slug))).toThrow(
      InvalidCommunityManifestSlugError,
    );
  });

  it.each(INVALID_SLUGS)("kit bundle import refuses %j without creating a Build", (slug) => {
    expect(() => repo.importKitBundle(kitBundle(slug), "Imported")).toThrow(
      InvalidCommunityManifestSlugError,
    );
    expect(repo.listProfileHeaders()).toEqual([]);
    expect(storedSlug()).toBe("ldo-2.4-sb-tap");
  });

  it("kit bundle import still applies a valid slug", () => {
    repo.importKitBundle(kitBundle("voron-stealthburner"), "Imported");
    expect(storedSlug()).toBe("voron-stealthburner");
  });

  it.each(INVALID_SLUGS)("assistant propose_update_source refuses %j", async (slug) => {
    const proposal = await invokeAssistantTool(
      "propose_update_source",
      { source_id: sourceId, patch: { manifest_community_slug: slug } },
      { repo },
    );
    expect(JSON.parse(proposal.content)).toEqual({ error: INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL });
    expect(proposal.proposedAction).toBeUndefined();
  });

  it.each(INVALID_SLUGS)("assistant apply refuses a stored proposal with %j", async (slug) => {
    const proposal = await invokeAssistantTool(
      "propose_update_source",
      { source_id: sourceId, patch: { manifest_community_slug: "voron-stealthburner" } },
      { repo },
    );
    const action = proposal.proposedAction!;
    const applied = await applyAssistantAction(
      { ...action, params: { ...action.params, patch: { manifest_community_slug: slug } } },
      { repo, jobs: { start: async () => "unused" } as never },
    );
    expect(applied).toEqual({ ok: false, detail: INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL });
    expect(storedSlug()).toBe("ldo-2.4-sb-tap");
  });

  it("POST /imports/kit-bundle rejects a malicious slug end to end", async () => {
    const app = Fastify();
    await app.register(multipart);
    await registerImportRoutes(app, { repo });
    const boundary = "----pp-kit-boundary";
    try {
      for (const slug of INVALID_SLUGS) {
        const response = await app.inject({
          method: "POST",
          url: "/imports/kit-bundle",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          payload: Buffer.concat([
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shared.print-partner-kit.zip"\r\nContent-Type: application/zip\r\n\r\n`,
            ),
            kitArchive(slug),
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]),
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ detail: INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL });
      }
      expect(repo.listProfileHeaders()).toEqual([]);
      expect(storedSlug()).toBe("ldo-2.4-sb-tap");
    } finally {
      await app.close();
    }
  });

  it("POST /admin/import-kit-bundle rejects a malicious slug end to end", async () => {
    const app = await buildApp({ ...loadConfig(), dataDir }, ports);
    try {
      for (const [index, slug] of INVALID_SLUGS.entries()) {
        const path = join(dataDir, `shared-${index}.print-partner-kit.zip`);
        writeFileSync(path, kitArchive(slug));
        const response = await app.inject({
          method: "POST",
          url: "/admin/import-kit-bundle",
          remoteAddress: "127.0.0.1",
          payload: { path },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ detail: INVALID_COMMUNITY_MANIFEST_SLUG_DETAIL });
      }
      expect(repo.listProfileHeaders()).toEqual([]);
      expect(storedSlug()).toBe("ldo-2.4-sb-tap");
    } finally {
      await app.close();
    }
  });
});
