export type DeploymentCapability = {
  database: "sqlite" | "postgres";
  artifact_store: "local_disk" | "s3";
  job_runner: "in_process";
  tenant_mode: "single" | "multi";
  support_status: "supported" | "experimental";
  restart: {
    database_rows: "survive";
    local_artifacts: "survive";
    in_flight_jobs: "lost";
  };
};

export function deploymentCapability(input: {
  databaseDriver: "sqlite" | "postgres";
  s3Bucket: string | null;
  multiUser: boolean;
}): DeploymentCapability {
  const artifactStore = input.s3Bucket ? "s3" : "local_disk";
  return {
    database: input.databaseDriver,
    artifact_store: artifactStore,
    job_runner: "in_process",
    tenant_mode: input.multiUser ? "multi" : "single",
    support_status:
      input.databaseDriver === "sqlite" && artifactStore === "local_disk"
        ? "supported"
        : "experimental",
    restart: {
      database_rows: "survive",
      local_artifacts: "survive",
      in_flight_jobs: "lost",
    },
  };
}
