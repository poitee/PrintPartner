import React from "react";
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from "react-router";
import * as Sentry from "@sentry/react";

const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();
export const sentryEnabled = Boolean(sentryDsn);
const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, "");

// Setting this list replaces the SDK default. Include same-origin absolute URLs
// because API calls are resolved against window.location.origin.
const tracePropagationTargets: Array<string | RegExp> = ["localhost", /^\//];
if (apiUrl) tracePropagationTargets.push(apiUrl);
if (typeof window !== "undefined" && window.location.origin) {
  tracePropagationTargets.push(window.location.origin);
}

if (sentryDsn) Sentry.init({
  dsn: sentryDsn,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_APP_VERSION,

  dataCollection: {
    // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/#dataCollection
    // userInfo: false,
    // httpBodies: [],
  },

  integrations: [
    Sentry.reactRouterV7BrowserTracingIntegration({
      useEffect: React.useEffect,
      useLocation,
      useNavigationType,
      createRoutesFromChildren,
      matchRoutes,
    }),
  ],

  // 1.0 while developing; keep production at the low end of the recommended range.
  tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
  tracePropagationTargets,
});
