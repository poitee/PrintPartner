import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for outbound HTTP fetches of user-controlled URLs.
 *
 * Strict default: reject URLs that resolve to private / loopback / link-local
 * ranges (cover images, page refetches, anything internet-facing).
 *
 * `allowPrivate: true`: for self-host integrations (Spoolman, Moonraker, Bambu MQTT)
 * that legitimately live on LAN/private IPs. Cloud metadata endpoints stay blocked
 * even then.
 */

const MAX_REDIRECTS = 5;

export type LookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export type OutboundUrlOptions = {
  /** Allow private/loopback/link-local targets (LAN integrations). */
  allowPrivate?: boolean;
  /** DNS resolver override (tests). */
  lookupFn?: LookupFn;
};

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlError";
  }
}

type AddressClass = "public" | "private" | "metadata";

const METADATA_IPV4 = "169.254.169.254";
const METADATA_IPV6 = "fd00:ec2::254";

function classifyIpv4(address: string): AddressClass {
  if (address === METADATA_IPV4) return "metadata";
  const octets = address.split(".").map(Number);
  const [a, b, c] = octets;
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return "private"; // unparseable: refuse rather than allow
  }
  if (a === 0 || a === 10 || a === 127) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT
  if (a === 169 && b === 254) return "private"; // link-local
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 192 && b === 0 && c === 0) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "private"; // benchmarking
  if (a >= 224) return "private"; // multicast, reserved, broadcast
  return "public";
}

function normalizeIpv6(address: string): string {
  return address.toLowerCase().split("%")[0] ?? "";
}

function classifyIpv6(address: string): AddressClass {
  const ip = normalizeIpv6(address);
  if (ip === METADATA_IPV6) return "metadata";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return classifyIpv4(mapped[1]!);
  if (ip === "::" || ip === "::1") return "private";
  if (ip.startsWith("fc") || ip.startsWith("fd")) return "private"; // ULA fc00::/7
  if (/^fe[89ab]/.test(ip)) return "private"; // link-local fe80::/10
  return "public";
}

export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);
  return "private";
}

const defaultLookup: LookupFn = (hostname) => lookup(hostname, { all: true, verbatim: true });

async function assertResolvedHostSafe(
  hostname: string,
  options: OutboundUrlOptions,
): Promise<void> {
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    const lookupFn = options.lookupFn ?? defaultLookup;
    try {
      addresses = (await lookupFn(hostname)).map((r) => r.address);
    } catch {
      throw new OutboundUrlError(`Could not resolve host: ${hostname}`);
    }
    if (!addresses.length) {
      throw new OutboundUrlError(`Could not resolve host: ${hostname}`);
    }
  }

  for (const address of addresses) {
    const cls = classifyAddress(address);
    if (cls === "metadata") {
      throw new OutboundUrlError(`URL resolves to a cloud metadata address: ${hostname}`);
    }
    if (cls === "private" && !options.allowPrivate) {
      throw new OutboundUrlError(`URL resolves to a private or internal address: ${hostname}`);
    }
  }
}

/**
 * SSRF guard for non-HTTP LAN targets (e.g. Bambu MQTT on :8883).
 * Validates hostname / IP the same way as {@link assertSafeOutboundUrl}.
 * Pass hostname or IP only — not `host:port` (use a separate port field).
 */
export async function assertSafeOutboundHost(
  rawHost: string,
  options: OutboundUrlOptions = {},
): Promise<string> {
  const hostname = rawHost.trim().replace(/^\[|\]$/g, "");
  if (!hostname) throw new OutboundUrlError("Host is required");
  if (/[/\\?\s#]/.test(hostname)) {
    throw new OutboundUrlError(`Invalid host: ${rawHost}`);
  }
  // Allow IPv6 literals (contain ":"); reject host:port forms that are not IPv6.
  if (hostname.includes(":") && isIP(hostname) !== 6) {
    throw new OutboundUrlError(`Invalid host (include port separately): ${rawHost}`);
  }
  await assertResolvedHostSafe(hostname, options);
  return hostname;
}

/**
 * Validate that a user-supplied URL is safe to fetch.
 * Throws OutboundUrlError if the URL is malformed, uses a non-HTTP protocol,
 * or resolves to a blocked address range. Returns the parsed URL on success.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  options: OutboundUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundUrlError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlError(`Unsupported URL protocol: ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new OutboundUrlError(`Invalid URL host: ${rawUrl}`);

  await assertResolvedHostSafe(hostname, options);
  return url;
}

/**
 * fetch() wrapper that validates the initial URL and every redirect hop
 * against the SSRF guard (redirects are followed manually).
 */
export async function safeOutboundFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: OutboundUrlOptions = {},
): Promise<Response> {
  let url = await assertSafeOutboundUrl(rawUrl, options);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      url = await assertSafeOutboundUrl(new URL(location, url).toString(), options);
      continue;
    }
    return response;
  }
  throw new OutboundUrlError(`Too many redirects fetching ${rawUrl}`);
}
