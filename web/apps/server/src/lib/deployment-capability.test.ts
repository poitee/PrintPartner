import { describe, expect, it } from "vitest";
import { deploymentCapability } from "./deployment-capability.js";

describe("deploymentCapability", () => {
  it("reports SQLite with local artifacts as supported", () => {
    expect(
      deploymentCapability({ databaseDriver: "sqlite", multiUser: false }),
    ).toEqual({
      database: "sqlite",
      job_runner: "in_process",
      tenant_mode: "single",
      support_status: "supported",
      restart: {
        database_rows: "survive",
        local_artifacts: "survive",
        in_flight_jobs: "lost",
      },
    });
  });

  it("reports Postgres as experimental", () => {
    expect(
      deploymentCapability({ databaseDriver: "postgres", multiUser: true }),
    ).toMatchObject({ support_status: "experimental", tenant_mode: "multi" });
  });
});
