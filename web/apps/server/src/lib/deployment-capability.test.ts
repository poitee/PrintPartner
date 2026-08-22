import { describe, expect, it } from "vitest";
import { deploymentCapability } from "./deployment-capability.js";

describe("deploymentCapability", () => {
  it("reports SQLite with local artifacts as supported", () => {
    expect(
      deploymentCapability({ databaseDriver: "sqlite", s3Bucket: null, multiUser: false }),
    ).toEqual({
      database: "sqlite",
      artifact_store: "local_disk",
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

  it("reports Postgres or S3 as experimental", () => {
    expect(
      deploymentCapability({ databaseDriver: "postgres", s3Bucket: null, multiUser: true }),
    ).toMatchObject({ support_status: "experimental", tenant_mode: "multi" });
    expect(
      deploymentCapability({ databaseDriver: "sqlite", s3Bucket: "bucket", multiUser: false }),
    ).toMatchObject({ support_status: "experimental", artifact_store: "s3" });
  });
});
