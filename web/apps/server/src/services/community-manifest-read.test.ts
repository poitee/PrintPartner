import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelfHostPorts } from "../adapters/self-host/index.js";
import { getLogger } from "./logger.js";
import { resolvePlanManifestSelections } from "./manifest-apply.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const { fileURLToPath } = await import("node:url");
  const file = fileURLToPath(new URL("../data/manifests/gre-702-fixture.yaml", import.meta.url));
  const fixture = fileURLToPath(new URL("../test-fixtures/community-manifest.yaml", import.meta.url));
  return {
    ...actual,
    realpathSync: new Proxy(actual.realpathSync, {
      apply(target, receiver, args) {
        return args[0] === file ? file : Reflect.apply(target, receiver, args);
      },
    }),
    statSync: new Proxy(actual.statSync, {
      apply(target, receiver, args) {
        return Reflect.apply(target, receiver, args[0] === file ? [fixture, ...args.slice(1)] : args);
      },
    }),
    readFileSync: vi.fn(new Proxy(actual.readFileSync, {
      apply(target, receiver, args) {
        return Reflect.apply(target, receiver, args[0] === file ? [fixture, ...args.slice(1)] : args);
      },
    })),
  };
});

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../data");
const MANIFESTS_DIR = join(DATA_DIR, "manifests");

describe("community manifest reads", () => {
  let dataDir: string;
  let ports: ReturnType<typeof createSelfHostPorts>;
  let repo: NonNullable<ReturnType<typeof createSelfHostPorts>["repository"]>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pp-community-read-"));
    ports = createSelfHostPorts(dataDir);
    await ports.db.connect();
    repo = ports.repository!;
  });

  afterEach(async () => {
    vi.mocked(fs.readFileSync).mockClear();
    await ports.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function planWithStoredSlug(slug: string): number {
    const source = repo.createSource({ name: "Addon", url: "https://example.test/addon" });
    const database = new DatabaseSync(join(dataDir, "print-partner.db"));
    database.prepare("UPDATE projects SET manifest_community_slug=? WHERE id=?").run(slug, source.id);
    database.close();
    return repo.createProfile("Plan", source.id).id;
  }

  function readPaths(): string[] {
    return vi.mocked(fs.readFileSync).mock.calls.map(([path]) => resolve(String(path)));
  }

  it("loads a valid slug from the manifests directory", () => {
    const slug = "gre-702-fixture";
    const file = join(MANIFESTS_DIR, `${slug}.yaml`);
    const planId = planWithStoredSlug(slug);
    expect(resolvePlanManifestSelections(repo, planId)).toEqual({ fixture_mode: "chosen" });
    expect(readPaths()).toContain(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    "kit-catalog",
    "registry-index",
    "../kit-catalog",
    "../path-hints",
    "..\\kit-catalog",
    "/etc/hostname",
    "a/b",
    "a\0b",
    "%2e%2e%2fkit-catalog",
    "C:\\kit-catalog",
    "a".repeat(65),
  ])("never reads outside the manifests directory for stored slug %j", (slug) => {
    const planId = planWithStoredSlug(slug);
    vi.mocked(fs.readFileSync).mockClear();
    const log = vi.spyOn(getLogger(), "log");
    try {
      expect(resolvePlanManifestSelections(repo, planId)).toEqual({});
      expect(log).toHaveBeenCalledWith("warn", "Ignoring invalid stored community manifest slug", { slug });
    } finally {
      log.mockRestore();
    }
    expect(readPaths()).not.toContain(join(DATA_DIR, "kit-catalog.yaml"));
    expect(readPaths().filter((path) => path.endsWith(".yaml"))).toEqual([]);
  });
});
