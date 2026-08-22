import { createHash, randomBytes } from "node:crypto";

/** Parse a WWW-Authenticate Digest challenge into key/value params. */
export function parseWwwAuthenticate(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const match = /^\s*Digest\s+(.+)$/i.exec(header.trim());
  if (!match) return params;
  const re = /(\w+)=(?:"((?:\\.|[^"\\])*)"|([^,\s]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[1]!)) !== null) {
    const quoted = m[2];
    const value = quoted ?? m[3] ?? "";
    // RFC 7616 parameter names are case-insensitive; normalize for lookups.
    params[m[1]!.toLowerCase()] = quoted === undefined ? value : value.replace(/\\(.)/g, "$1");
  }
  return params;
}

function md5(value: string): string {
  // HTTP Digest Auth (RFC 7616 / PrusaLink) requires MD5 for HA1/HA2 — not password storage.
  return createHash("md5").update(value).digest("hex");
}

/** Quote a Digest auth parameter; reject CR/LF that would break the header. */
export function quoteDigestParam(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Invalid digest parameter");
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Prefer qop=auth when offered; never select auth-int (we don't hash the entity body). */
export function pickDigestQop(qopRaw: string): string | undefined {
  const options = qopRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (options.includes("auth")) return "auth";
  if (options.length > 0) {
    throw new Error(`Unsupported digest qop: ${qopRaw}`);
  }
  // No qop in challenge → RFC 2069 (legacy no-qop response).
  return undefined;
}

/** Build an Authorization: Digest … header for an HTTP Digest challenge (MD5 / auth). */
export function buildDigestAuthorization(opts: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: Record<string, string>;
  nc?: number;
}): string {
  const { username, password, method, uri, challenge } = opts;
  const realm = challenge.realm ?? "";
  const nonce = challenge.nonce ?? "";
  const qop = pickDigestQop(challenge.qop ?? "");
  const opaque = challenge.opaque;
  const algorithm = (challenge.algorithm ?? "MD5").toUpperCase();
  if (algorithm !== "MD5" && algorithm !== "MD5-SESS") {
    throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }

  let ha1 = md5(`${username}:${realm}:${password}`);
  const cnonce = randomBytes(8).toString("hex");
  if (algorithm === "MD5-SESS") {
    ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  }
  const ha2 = md5(`${method}:${uri}`);
  // RFC 7616: nc is 8LHEX (nonce count as 8 lowercase hex digits).
  const ncRaw = opts.nc ?? 1;
  if (!Number.isInteger(ncRaw) || ncRaw < 1 || ncRaw > 0xffffffff) {
    throw new Error("Invalid digest nc");
  }
  const nc = ncRaw.toString(16).padStart(8, "0");
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `Digest username=${quoteDigestParam(username)}`,
    `realm=${quoteDigestParam(realm)}`,
    `nonce=${quoteDigestParam(nonce)}`,
    `uri=${quoteDigestParam(uri)}`,
    `response=${quoteDigestParam(response)}`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quoteDigestParam(cnonce)}`);
  } else if (algorithm === "MD5-SESS") {
    // MD5-SESS folds cnonce into HA1; server must receive it even without qop.
    parts.push(`cnonce=${quoteDigestParam(cnonce)}`);
  }
  if (opaque) parts.push(`opaque=${quoteDigestParam(opaque)}`);
  parts.push(`algorithm=${algorithm}`);
  return parts.join(", ");
}
