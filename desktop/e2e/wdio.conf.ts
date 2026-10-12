import { installOwnedLifecycle } from "./src/owned-lifecycle.ts";

installOwnedLifecycle();

function requiredText(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredPort(name: string): number {
  const raw = requiredText(name);
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a TCP port`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port`);
  }
  return port;
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {
    LIBGL_ALWAYS_SOFTWARE: "1",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
  };
  for (const name of [
    "DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = process.env[name];
    if (value) {
      env[name] = value;
    }
  }
  return env;
}

const binary = requiredText("GRE492_APP_BINARY");
const stage = requiredText("GRE492_STAGE");
const data = requiredText("GRE492_DATA");
const output = requiredText("GRE492_OUTPUT");

export const config = {
  runner: "local",
  specs: ["./specs/**/*.ts"],
  maxInstances: 1,
  specFileRetries: 0,
  outputDir: output,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: binary,
      },
    },
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 20000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 180000,
  },
  services: [
    [
      "@wdio/tauri-service",
      {
        driverProvider: "embedded",
        appBinaryPath: binary,
        appArgs: ["--dev-stage", stage, "--data", data],
        embeddedPort: requiredPort("GRE492_PORT"),
        startTimeout: 90000,
        autoInstallTauriDriver: false,
        captureBackendLogs: true,
        logDir: output,
        env: childEnv(),
      },
    ],
  ],
};
