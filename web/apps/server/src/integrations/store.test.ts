import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, SqliteDatabase } from "../db/client.js";
import { AppRepository } from "../db/repository.js";
import { createIntegrationPort } from "./store.js";
import { spoolmanAdapter } from "./adapters/spoolman.js";
import { moonrakerAdapter } from "./adapters/moonraker.js";
import { bambuAdapter } from "./adapters/bambu.js";

describe("integration store", () => {
  it("preserves secrets when patch contains redacted placeholders", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-int-store-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const port = createIntegrationPort({
      repo,
      getAdapter: (type) => (type === "spoolman" ? spoolmanAdapter : undefined),
    });

    const created = port.create({
      type: "spoolman",
      name: "Workshop",
      config: { base_url: "http://192.168.1.50:7912", api_key: "real-secret" },
    });

    const listed = port.list().find((x) => x.id === created.id)!;
    expect(listed.config.api_key).toBe("****");

    const updated = port.update(created.id, {
      config: { ...listed.config, enabled: false },
    });
    expect(updated?.config.enabled).toBe(false);

    const raw = repo.getSetting("integrations");
    expect(raw).toContain("real-secret");
    expect(raw).not.toContain('"api_key":"****"');

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("redacts search_api_key like api_key", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-int-search-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const port = createIntegrationPort({
      repo,
      getAdapter: (type) => (type === "spoolman" ? spoolmanAdapter : undefined),
    });

    const created = port.create({
      type: "ai_assistant",
      name: "Advisor",
      config: {
        provider: "ollama",
        model: "llama3.1",
        search_api_key: "brave-secret",
        api_key: "unused",
      },
    });

    const listed = port.list().find((x) => x.id === created.id)!;
    expect(listed.config.search_api_key).toBe("****");
    expect(listed.config.api_key).toBe("****");

    port.update(created.id, {
      config: { ...listed.config, search_provider: "brave" },
    });
    const raw = repo.getSetting("integrations");
    expect(raw).toContain("brave-secret");
    expect(raw).not.toContain('"search_api_key":"****"');

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("redacts and preserves camelCase apiKey / accessCode aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-int-camel-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const port = createIntegrationPort({
      repo,
      getAdapter: (type) => (type === "spoolman" ? spoolmanAdapter : undefined),
    });

    const created = port.create({
      type: "moonraker",
      name: "Pi",
      config: {
        base_url: "http://192.168.1.60:7125",
        apiKey: "moonraker-secret",
        accessCode: "bambu-lan-code",
      },
    });

    const listed = port.list().find((x) => x.id === created.id)!;
    expect(listed.config.apiKey).toBe("****");
    expect(listed.config.accessCode).toBe("****");

    const updated = port.update(created.id, {
      config: { ...listed.config, enabled: true },
    });
    expect(updated?.config.apiKey).toBe("****");
    expect(updated?.config.accessCode).toBe("****");

    const raw = repo.getSetting("integrations");
    expect(raw).toContain("moonraker-secret");
    expect(raw).toContain("bambu-lan-code");
    expect(raw).not.toContain('"apiKey":"****"');
    expect(raw).not.toContain('"accessCode":"****"');

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("derives host capabilities from the adapter and never persists them", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-int-caps-"));
    const sqlite = new SqliteDatabase(dir);
    sqlite.connect();
    const repo = new AppRepository(getDb(sqlite), undefined, sqlite.reposDir);
    const port = createIntegrationPort({
      repo,
      getAdapter: (type) => {
        if (type === "moonraker") return moonrakerAdapter;
        if (type === "bambu") return bambuAdapter;
        if (type === "spoolman") return spoolmanAdapter;
        return undefined;
      },
    });

    const moonraker = port.create({ type: "moonraker", name: "Voron", config: {} });
    const bambu = port.create({ type: "bambu", name: "X1C", config: {} });
    const spoolman = port.create({ type: "spoolman", name: "Spools", config: {} });

    const listed = port.list();
    const capabilitiesOf = (id: string) =>
      listed.find((row) => row.id === id)?.capabilities;

    // Moonraker browses files and serves cameras.
    expect(capabilitiesOf(moonraker.id))
      .toEqual({ files: true, cameras: true, status: true });
    // Bambu reports print state but browses no files, so it is a printer host
    // that can bind a Plan even though it cannot list stored files. The client
    // used to hide Plan binding from it by hardcoding moonraker/prusalink.
    expect(capabilitiesOf(bambu.id))
      .toEqual({ files: false, cameras: false, status: true });
    // Spoolman is not a printer host at all.
    expect(capabilitiesOf(spoolman.id))
      .toEqual({ files: false, cameras: false, status: false });

    expect(port.get(bambu.id)?.capabilities?.status).toBe(true);

    // Derived on read only: a stored capability would go stale the moment an
    // adapter gained or lost one.
    expect(repo.getSetting("integrations")).not.toContain("capabilities");

    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
