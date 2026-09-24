import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

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

let privateOutboundDenied = false;

export function setPrivateOutboundDenied(denied: boolean): void {
  privateOutboundDenied = denied;
}

function privateTargetsAllowed(options: OutboundUrlOptions): boolean {
  return Boolean(options.allowPrivate) && !privateOutboundDenied;
}

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
  return address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
}

/** Expand a compressed IPv6 literal into eight hex groups, or null if unparseable. */
function expandIpv6Groups(ip: string): string[] | null {
  if (ip.includes(".")) return null;
  const sides = ip.split("::");
  if (sides.length > 2) return null;
  const parseSide = (side: string): string[] => (side === "" ? [] : side.split(":"));
  if (sides.length === 1) {
    const groups = parseSide(sides[0]!);
    return groups.length === 8 ? groups : null;
  }
  const head = parseSide(sides[0]!);
  const tail = parseSide(sides[1]!);
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<string>(missing).fill("0"), ...tail];
}

/** IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:7f00:1). Node URL uses the hex form. */
function ipv4FromMappedIpv6(ip: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) return dotted[1]!;
  const groups = expandIpv6Groups(ip);
  if (!groups) return null;
  const parsed = groups.map((group) => Number.parseInt(group, 16));
  if (parsed.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  if (
    parsed[0] !== 0 ||
    parsed[1] !== 0 ||
    parsed[2] !== 0 ||
    parsed[3] !== 0 ||
    parsed[4] !== 0 ||
    parsed[5] !== 0xffff
  ) {
    return null;
  }
  const hi = parsed[6]!;
  const lo = parsed[7]!;
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function classifyIpv6(address: string): AddressClass {
  const ip = normalizeIpv6(address);
  if (ip === METADATA_IPV6) return "metadata";
  const mappedIpv4 = ipv4FromMappedIpv6(ip);
  if (mappedIpv4) return classifyIpv4(mappedIpv4);
  if (ip === "::" || ip === "::1") return "private";
  if (ip.startsWith("fc") || ip.startsWith("fd")) return "private"; // ULA fc00::/7
  if (/^fe[89ab]/.test(ip)) return "private"; // link-local fe80::/10
  return "public";
}

export function classifyAddress(address: string): AddressClass {
  const host = address.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) return classifyIpv4(host);
  if (family === 6) return classifyIpv6(host);
  return "private";
}

const defaultLookup: LookupFn = (hostname) => lookup(hostname, { all: true, verbatim: true });

async function assertResolvedHostSafe(
  hostname: string,
  options: OutboundUrlOptions,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
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

  const checked: Array<{ address: string; family: 4 | 6 }> = [];
  for (const address of addresses) {
    const cls = classifyAddress(address);
    if (cls === "metadata") {
      throw new OutboundUrlError(`URL resolves to a cloud metadata address: ${hostname}`);
    }
    if (cls === "private" && !privateTargetsAllowed(options)) {
      throw new OutboundUrlError(`URL resolves to a private or internal address: ${hostname}`);
    }
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      throw new OutboundUrlError(`Invalid address for host: ${hostname}`);
    }
    checked.push({ address, family });
  }
  return checked;
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
  init: {
    method?: string;
    headers?: Record<string, string> | [string, string][];
    body?: string | null;
    signal?: AbortSignal | null;
    redirect?: RequestInit["redirect"];
  } = {},
  options: OutboundUrlOptions = {},
): Promise<Response> {
  let url = await assertSafeOutboundUrl(rawUrl, options);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const dispatcher = new Agent({
      connect: {
        autoSelectFamily: true,
        lookup: (hostname, lookupOptions, callback) => {
          void assertResolvedHostSafe(hostname, options).then(
            (addresses) => {
              const first = addresses[0];
              if (!first) return callback(new OutboundUrlError(`Could not resolve host: ${hostname}`), "", 4);
              if (lookupOptions.all) callback(null, addresses);
              else callback(null, first.address, first.family);
            },
            (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), "", 4),
          );
        },
      },
    });
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(url, {
        ...init,
        redirect: "manual",
        dispatcher,
      });
    } catch (error) {
      dispatcher.destroy();
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return responseWithDispatcher(response, dispatcher, hop > 0);
      try {
        await response.body?.cancel();
      } finally {
        dispatcher.destroy();
      }
      url = await assertSafeOutboundUrl(new URL(location, url).toString(), options);
      continue;
    }
    return responseWithDispatcher(response, dispatcher, hop > 0);
  }
  throw new OutboundUrlError(`Too many redirects fetching ${rawUrl}`);
}

function responseWithDispatcher(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  dispatcher: Agent,
  redirected: boolean,
): Response {
  const reader = response.body?.getReader();
  const body = reader ? new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          dispatcher.destroy();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        dispatcher.destroy();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        dispatcher.destroy();
      }
    },
  }) : null;
  if (!body) dispatcher.destroy();
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers),
  });
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: redirected },
    type: { value: response.type },
  });
  return wrapped;
}
