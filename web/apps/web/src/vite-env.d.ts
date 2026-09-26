/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Optional Google OAuth Web client id for Drive (dev fallback if /health has none). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Enables browser error reporting when set to a non-empty DSN at build time. */
  readonly VITE_SENTRY_DSN?: string;
  /** Product version injected from web/package.json at build time. */
  readonly VITE_APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
