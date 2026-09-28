type DeploymentCapability = {
  database: "sqlite" | "postgres";
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
  multiUser: boolean;
}): DeploymentCapability {
  return {
    database: input.databaseDriver,
    job_runner: "in_process",
    tenant_mode: input.multiUser ? "multi" : "single",
    support_status: input.databaseDriver === "sqlite" ? "supported" : "experimental",
    restart: {
      database_rows: "survive",
      local_artifacts: "survive",
      in_flight_jobs: "lost",
    },
  };
}
