import { describe, expect, it } from "vitest";
import { buildDigestAuthorization, parseWwwAuthenticate } from "./digest-auth.js";

describe("digest-auth", () => {
  it("parses WWW-Authenticate Digest challenges", () => {
    const header =
      'Digest realm="Printer API", nonce="abc123", qop="auth", algorithm=MD5, opaque="xyz"';
    expect(parseWwwAuthenticate(header)).toEqual({
      realm: "Printer API",
      nonce: "abc123",
      qop: "auth",
      algorithm: "MD5",
      opaque: "xyz",
    });
  });

  it("lowercases mixed-case Digest parameter names", () => {
    const header =
      'Digest Realm="Printer API", Nonce="abc123", Qop="auth", Algorithm=MD5';
    expect(parseWwwAuthenticate(header)).toEqual({
      realm: "Printer API",
      nonce: "abc123",
      qop: "auth",
      algorithm: "MD5",
    });
    const authorization = buildDigestAuthorization({
      username: "maker",
      password: "secret",
      method: "GET",
      uri: "/api/v1/status",
      challenge: parseWwwAuthenticate(header),
      nc: 1,
    });
    expect(authorization).toContain('realm="Printer API"');
    expect(authorization).toContain('nonce="abc123"');
    expect(authorization).toContain("qop=auth");
  });

  it("unescapes quoted Digest challenge parameters", () => {
    const header = 'Digest realm="Print\\"er", nonce="a\\\\b", qop="auth"';
    expect(parseWwwAuthenticate(header)).toEqual({
      realm: 'Print"er',
      nonce: "a\\b",
      qop: "auth",
    });
  });

  it("builds a Digest Authorization header with qop=auth", () => {
    const authorization = buildDigestAuthorization({
      username: "maker",
      password: "secret",
      method: "GET",
      uri: "/api/v1/status",
      challenge: {
        realm: "Printer API",
        nonce: "n1",
        qop: "auth",
        algorithm: "MD5",
      },
      nc: 1,
    });
    expect(authorization).toMatch(/^Digest /);
    expect(authorization).toContain('username="maker"');
    expect(authorization).toContain('realm="Printer API"');
    expect(authorization).toContain('nonce="n1"');
    expect(authorization).toContain('uri="/api/v1/status"');
    expect(authorization).toContain("qop=auth");
    expect(authorization).toContain("nc=00000001");
    expect(authorization).toContain("response=");
  });

  it("prefers qop=auth when multiple qop values are offered", () => {
    const authorization = buildDigestAuthorization({
      username: "maker",
      password: "secret",
      method: "GET",
      uri: "/api/v1/status",
      challenge: {
        realm: "Printer API",
        nonce: "n1",
        qop: "auth-int, auth",
        algorithm: "MD5",
      },
    });
    expect(authorization).toContain("qop=auth");
    expect(authorization).not.toContain("qop=auth-int");
  });

  it("throws when only unsupported qop is offered", () => {
    expect(() =>
      buildDigestAuthorization({
        username: "maker",
        password: "secret",
        method: "GET",
        uri: "/api/v1/status",
        challenge: {
          realm: "Printer API",
          nonce: "n1",
          qop: "auth-int",
          algorithm: "MD5",
        },
      }),
    ).toThrow(/Unsupported digest qop/i);
  });

  it("omits qop when the challenge has no qop", () => {
    const authorization = buildDigestAuthorization({
      username: "maker",
      password: "secret",
      method: "GET",
      uri: "/api/v1/status",
      challenge: {
        realm: "Printer API",
        nonce: "n1",
        algorithm: "MD5",
      },
    });
    expect(authorization).not.toContain("qop=");
    expect(authorization).not.toContain("nc=");
  });

  it("formats nc as 8-digit lowercase hex", () => {
    const authorization = buildDigestAuthorization({
      username: "maker",
      password: "secret",
      method: "GET",
      uri: "/api/v1/status",
      challenge: {
        realm: "Printer API",
        nonce: "n1",
        qop: "auth",
        algorithm: "MD5",
      },
      nc: 10,
    });
    expect(authorization).toContain("nc=0000000a");
    expect(authorization).not.toContain("nc=00000010");
  });

  it("emits cnonce for MD5-SESS even without qop", () => {
    const authorization = buildDigestAuthorization({
      username: "maker",
      password: "secret",
      method: "GET",
      uri: "/api/v1/status",
      challenge: {
        realm: "Printer API",
        nonce: "n1",
        algorithm: "MD5-SESS",
      },
    });
    expect(authorization).toContain("cnonce=");
    expect(authorization).not.toContain("qop=");
    expect(authorization).not.toContain("nc=");
    expect(authorization).toContain("algorithm=MD5-SESS");
  });

  it("escapes quotes in username and rejects CR/LF", () => {
    const authorization = buildDigestAuthorization({
      username: 'ma"ker',
      password: "secret",
      method: "GET",
      uri: "/api/v1/status",
      challenge: { realm: "Printer API", nonce: "n1", algorithm: "MD5" },
    });
    expect(authorization).toContain('username="ma\\"ker"');
    expect(() =>
      buildDigestAuthorization({
        username: "bad\nuser",
        password: "secret",
        method: "GET",
        uri: "/api/v1/status",
        challenge: { realm: "Printer API", nonce: "n1", algorithm: "MD5" },
      }),
    ).toThrow(/Invalid digest parameter/);
  });
});
