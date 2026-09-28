import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createSelfHostPorts } from "../adapters/self-host/index.js";

type TestApp = {
  app: Awaited<ReturnType<typeof buildApp>>;
  ports: ReturnType<typeof createSelfHostPorts>;
};

export async function makeApp(dir: string): Promise<TestApp> {
  process.env.PRINT_PARTNER_DATA_DIR = dir;
  delete process.env.PRINT_PARTNER_API_KEY;
  const config = loadConfig();
  const ports = createSelfHostPorts(dir);
  await ports.db.connect();
  const app = await buildApp(config, ports);
  return { app, ports };
}
