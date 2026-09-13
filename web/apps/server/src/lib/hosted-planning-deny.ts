export const HOSTED_LAN_DISABLED_DETAIL =
  "Live printer hosts are disabled on the hosted planning site. Use Compose on the shop LAN.";

export const HOSTED_FEATURE_DISABLED_DETAIL =
  "This feature is off on the hosted planning site.";

type DenyRule = Readonly<{
  method: string;
  pattern: RegExp;
  detail: string;
}>;

const RULES: readonly DenyRule[] = [
  { method: "POST", pattern: /^\/integrations$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  { method: "PATCH", pattern: /^\/integrations\/[^/]+$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  { method: "DELETE", pattern: /^\/integrations\/[^/]+$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  { method: "POST", pattern: /^\/integrations\/[^/]+\/test$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  { method: "GET", pattern: /^\/integrations\/[^/]+\/status$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  { method: "GET", pattern: /^\/integrations\/[^/]+\/devices$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  {
    method: "GET",
    pattern: /^\/integrations\/[^/]+\/spoolman(?:\/|$)/,
    detail: HOSTED_LAN_DISABLED_DETAIL,
  },
  { method: "POST", pattern: /^\/jobs\/printer-upload$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  { method: "POST", pattern: /^\/printer-send-queue$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  {
    method: "POST",
    pattern: /^\/printer-send-queue\/[^/]+\/dispatch$/,
    detail: HOSTED_LAN_DISABLED_DETAIL,
  },
  { method: "POST", pattern: /^\/printer-send-queue\/drain$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  { method: "GET", pattern: /^\/printers\/[^/]+\/files(?:\/content)?$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  { method: "GET", pattern: /^\/printers\/[^/]+\/cameras(?:\/view)?$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  {
    method: "POST",
    pattern: /^\/slicer-instances\/[^/]+\/open-accepted-plates$/,
    detail: HOSTED_FEATURE_DISABLED_DETAIL,
  },
  {
    method: "POST",
    pattern: /^\/slicer-instances\/[^/]+\/docker-(?:pull|start|stop)$/,
    detail: HOSTED_FEATURE_DISABLED_DETAIL,
  },
  {
    method: "GET",
    pattern: /^\/slicer-instances\/[^/]+\/docker-(?:status|logs)$/,
    detail: HOSTED_FEATURE_DISABLED_DETAIL,
  },
  { method: "POST", pattern: /^\/bambu-connect\/handoff$/, detail: HOSTED_LAN_DISABLED_DETAIL },
  { method: "POST", pattern: /^\/webhooks$/, detail: HOSTED_FEATURE_DISABLED_DETAIL },
  {
    method: "POST",
    pattern: /^\/printer-checkoff\/reconcile$/,
    detail: HOSTED_LAN_DISABLED_DETAIL,
  },
  { method: "PUT", pattern: /^\/settings\/github-pat$/, detail: HOSTED_FEATURE_DISABLED_DETAIL },
  { method: "PUT", pattern: /^\/settings\/discord-notify$/, detail: HOSTED_FEATURE_DISABLED_DETAIL },
  {
    method: "POST",
    pattern: /^\/settings\/discord-notify\/test$/,
    detail: HOSTED_FEATURE_DISABLED_DETAIL,
  },
  { method: "POST", pattern: /^\/api\/discord-digest$/, detail: HOSTED_FEATURE_DISABLED_DETAIL },
  {
    method: "PUT",
    pattern: /^\/settings\/external-access$/,
    detail: HOSTED_FEATURE_DISABLED_DETAIL,
  },
  { method: "*", pattern: /^\/backups(?:\/|$)/, detail: HOSTED_FEATURE_DISABLED_DETAIL },
  {
    method: "*",
    pattern: /^\/settings\/api-keys(?:\/|$)/,
    detail: HOSTED_FEATURE_DISABLED_DETAIL,
  },
  { method: "*", pattern: /^\/mcp$/, detail: HOSTED_FEATURE_DISABLED_DETAIL },
];

export function normalizeHostedApiPath(url: string): string {
  const path = (url.split("?")[0] ?? url).replace(/\/+$/, "") || "/";
  if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    const stripped = path.slice("/api/v1".length);
    return stripped === "" ? "/" : stripped;
  }
  return path;
}

export function hostedDeniedRouteDetail(method: string, url: string): string | null {
  const path = normalizeHostedApiPath(url);
  const verb = method.toUpperCase();
  for (const rule of RULES) {
    if ((rule.method === "*" || rule.method === verb) && rule.pattern.test(path)) {
      return rule.detail;
    }
  }
  return null;
}
