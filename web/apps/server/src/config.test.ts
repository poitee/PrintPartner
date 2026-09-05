import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, validateProductionConfig } from "./config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("keeps printer reporting opt-in even when a DSN is present", () => {
    vi.stubEnv("SENTRY_ENABLED", undefined);
    vi.stubEnv("SENTRY_DSN", "https://publickey@o123.ingest.sentry.io/456");
    vi.stubEnv("SENTRY_ENVIRONMENT", "staging");
    expect(loadConfig().printerErrorReporting).toEqual({
      enabled: false,
      dsn: "https://publickey@o123.ingest.sentry.io/456",
      environment: "staging",
    });

    vi.stubEnv("SENTRY_ENABLED", "1");
    expect(loadConfig().printerErrorReporting.enabled).toBe(true);
  });

  it("loads disabled reporting without a destination and uses the runtime environment", () => {
    vi.stubEnv("SENTRY_ENABLED", undefined);
    vi.stubEnv("SENTRY_DSN", undefined);
    vi.stubEnv("SENTRY_ENVIRONMENT", undefined);
    vi.stubEnv("NODE_ENV", "production");
    expect(loadConfig().printerErrorReporting).toEqual({
      enabled: false,
      dsn: null,
      environment: "production",
    });
  });

  it("does not require an unused session secret for self-host single-user auth", () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      DEPLOY_MODE: process.env.DEPLOY_MODE,
      SINGLE_USER_AUTH: process.env.SINGLE_USER_AUTH,
      SESSION_SECRET: process.env.SESSION_SECRET,
    };

    try {
      process.env.NODE_ENV = "production";
      process.env.DEPLOY_MODE = "self-host";
      process.env.SINGLE_USER_AUTH = "1";
      delete process.env.SESSION_SECRET;

      const config = loadConfig();
      expect(config.authRequired).toBe(true);
      expect(config.sessionSecret).toBeNull();
      expect(() => validateProductionConfig(config)).not.toThrow();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("enables authenticated single-user mode without enabling sharing", () => {
    const previous = {
      DEPLOY_MODE: process.env.DEPLOY_MODE,
      SINGLE_USER_AUTH: process.env.SINGLE_USER_AUTH,
      MULTI_USER: process.env.MULTI_USER,
    };
    process.env.DEPLOY_MODE = "self-host";
    process.env.SINGLE_USER_AUTH = "1";
    process.env.MULTI_USER = "0";

    const config = loadConfig();
    expect(config.singleUserAuth).toBe(true);
    expect(config.multiUser).toBe(false);
    expect(config.authRequired).toBe(true);

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("enables proxy trust only when explicitly configured", () => {
    const previous = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    expect(loadConfig().trustProxy).toBe(false);

    process.env.TRUST_PROXY = "1";
    expect(loadConfig().trustProxy).toBe(true);

    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  });

  it("defaults to self-host deploy mode", () => {
    const prev = process.env.DEPLOY_MODE;
    delete process.env.DEPLOY_MODE;
    const config = loadConfig();
    expect(config.deployMode).toBe("self-host");
    if (prev !== undefined) process.env.DEPLOY_MODE = prev;
  });

  it("fails closed for production Postgres unless the experimental gate is explicit", () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      DEPLOY_MODE: process.env.DEPLOY_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      POSTGRES_EXPERIMENTAL: process.env.POSTGRES_EXPERIMENTAL,
      MULTI_USER: process.env.MULTI_USER,
      SAAS_ALLOW_ANONYMOUS: process.env.SAAS_ALLOW_ANONYMOUS,
    };
    process.env.NODE_ENV = "production";
    process.env.DEPLOY_MODE = "saas";
    process.env.DATABASE_URL = "postgresql://printpartner:printpartner@postgres/printpartner";
    process.env.MULTI_USER = "0";
    process.env.SAAS_ALLOW_ANONYMOUS = "1";
    delete process.env.POSTGRES_EXPERIMENTAL;

    const blocked = loadConfig();
    expect(blocked.postgresExperimental).toBe(false);
    expect(() => validateProductionConfig(blocked)).toThrow(/Postgres.*experimental/i);

    process.env.POSTGRES_EXPERIMENTAL = "1";
    const optedIn = loadConfig();
    expect(optedIn.postgresExperimental).toBe(true);
    expect(() => validateProductionConfig(optedIn)).not.toThrow();

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("requires a canonical public URL for production password-reset email", () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_FROM: process.env.SMTP_FROM,
      APP_PUBLIC_URL: process.env.APP_PUBLIC_URL,
    };
    try {
      process.env.NODE_ENV = "production";
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.SMTP_FROM = "noreply@example.com";
      delete process.env.APP_PUBLIC_URL;

      expect(() => validateProductionConfig(loadConfig())).toThrow(/APP_PUBLIC_URL/);

      process.env.APP_PUBLIC_URL = "https://print.example.com";
      expect(() => validateProductionConfig(loadConfig())).not.toThrow();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps AI disabled unless AI_ENABLED=1 with credentials", () => {
    const prev = {
      AI_ENABLED: process.env.AI_ENABLED,
      AI_PROVIDER: process.env.AI_PROVIDER,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    delete process.env.AI_ENABLED;
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(loadConfig().aiEnabled).toBe(false);

    process.env.AI_ENABLED = "1";
    const enabled = loadConfig();
    expect(enabled.aiEnabled).toBe(true);
    expect(enabled.aiProvider).toBe("anthropic");
    expect(enabled.aiModel).toBeTruthy();

    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("parses AI daily budget env vars (0 = unlimited)", () => {
    const prev = {
      AI_DAILY_REQUEST_BUDGET: process.env.AI_DAILY_REQUEST_BUDGET,
      AI_DAILY_TOKEN_BUDGET: process.env.AI_DAILY_TOKEN_BUDGET,
    };
    delete process.env.AI_DAILY_REQUEST_BUDGET;
    delete process.env.AI_DAILY_TOKEN_BUDGET;
    expect(loadConfig().aiDailyRequestBudget).toBe(0);
    expect(loadConfig().aiDailyTokenBudget).toBe(0);

    process.env.AI_DAILY_REQUEST_BUDGET = "40";
    process.env.AI_DAILY_TOKEN_BUDGET = "100000";
    const capped = loadConfig();
    expect(capped.aiDailyRequestBudget).toBe(40);
    expect(capped.aiDailyTokenBudget).toBe(100000);

    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults SOURCE_DOCS_MAX_BYTES to 1 GiB", () => {
    const prev = process.env.SOURCE_DOCS_MAX_BYTES;
    delete process.env.SOURCE_DOCS_MAX_BYTES;
    expect(loadConfig().sourceDocsMaxBytes).toBe(1024 * 1024 * 1024);
    if (prev === undefined) delete process.env.SOURCE_DOCS_MAX_BYTES;
    else process.env.SOURCE_DOCS_MAX_BYTES = prev;
  });

  it("defaults assistant URL ingest on with 512 KiB max", () => {
    const prevAllow = process.env.ASSISTANT_ALLOW_URL_INGEST;
    const prevMax = process.env.ASSISTANT_GUIDE_INGEST_MAX_BYTES;
    delete process.env.ASSISTANT_ALLOW_URL_INGEST;
    delete process.env.ASSISTANT_GUIDE_INGEST_MAX_BYTES;
    const cfg = loadConfig();
    expect(cfg.assistantAllowUrlIngest).toBe(true);
    expect(cfg.assistantGuideIngestMaxBytes).toBe(512 * 1024);

    process.env.ASSISTANT_ALLOW_URL_INGEST = "0";
    process.env.ASSISTANT_GUIDE_INGEST_MAX_BYTES = "1024";
    const off = loadConfig();
    expect(off.assistantAllowUrlIngest).toBe(false);
    expect(off.assistantGuideIngestMaxBytes).toBe(1024);

    if (prevAllow === undefined) delete process.env.ASSISTANT_ALLOW_URL_INGEST;
    else process.env.ASSISTANT_ALLOW_URL_INGEST = prevAllow;
    if (prevMax === undefined) delete process.env.ASSISTANT_GUIDE_INGEST_MAX_BYTES;
    else process.env.ASSISTANT_GUIDE_INGEST_MAX_BYTES = prevMax;
  });

  it("parses SEARCH_PROVIDER and SEARCH_API_KEY (with Brave/Exa fallbacks)", () => {
    const prev = {
      SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
      SEARCH_API_KEY: process.env.SEARCH_API_KEY,
      BRAVE_API_KEY: process.env.BRAVE_API_KEY,
      EXA_API_KEY: process.env.EXA_API_KEY,
    };
    delete process.env.SEARCH_PROVIDER;
    delete process.env.SEARCH_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.EXA_API_KEY;
    expect(loadConfig().searchProvider).toBeNull();
    expect(loadConfig().searchApiKey).toBeNull();

    process.env.SEARCH_PROVIDER = "brave";
    process.env.BRAVE_API_KEY = "brave-key";
    const brave = loadConfig();
    expect(brave.searchProvider).toBe("brave");
    expect(brave.searchApiKey).toBe("brave-key");

    process.env.SEARCH_API_KEY = "shared-key";
    expect(loadConfig().searchApiKey).toBe("shared-key");

    process.env.SEARCH_PROVIDER = "not-a-provider";
    expect(loadConfig().searchProvider).toBeNull();

    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
});
