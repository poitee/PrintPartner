import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeOutboundHost,
  assertSafeOutboundUrl,
  classifyAddress,
  OutboundUrlError,
  safeOutboundFetch,
  type LookupFn,
} from "./outbound-url.js";

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup: LookupFn = async () => [{ address: "10.0.0.8", family: 4 }];
const loopbackLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];

describe("classifyAddress", () => {
  it("classifies IPv4 ranges", () => {
    expect(classifyAddress("93.184.216.34")).toBe("public");
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("127.0.0.1")).toBe("private");
    expect(classifyAddress("10.1.2.3")).toBe("private");
    expect(classifyAddress("172.16.0.1")).toBe("private");
    expect(classifyAddress("192.168.1.50")).toBe("private");
    expect(classifyAddress("169.254.0.10")).toBe("private");
    expect(classifyAddress("100.64.0.1")).toBe("private");
    expect(classifyAddress("0.0.0.0")).toBe("private");
    expect(classifyAddress("169.254.169.254")).toBe("metadata");
  });

  it("classifies IPv6 ranges", () => {
    expect(classifyAddress("::1")).toBe("private");
    expect(classifyAddress("fe80::1")).toBe("private");
    expect(classifyAddress("fd12:3456::1")).toBe("private");
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:169.254.169.254")).toBe("metadata");
    expect(classifyAddress("fd00:ec2::254")).toBe("metadata");
    expect(classifyAddress("2606:4700::1111")).toBe("public");
  });
});

describe("assertSafeOutboundUrl", () => {
  it("rejects malformed URLs and non-HTTP protocols", async () => {
    await expect(assertSafeOutboundUrl("not a url")).rejects.toThrow(OutboundUrlError);
    await expect(assertSafeOutboundUrl("ftp://example.com/x")).rejects.toThrow(
      /Unsupported URL protocol/,
    );
    await expect(assertSafeOutboundUrl("file:///etc/passwd")).rejects.toThrow(
      /Unsupported URL protocol/,
    );
  });

  it("rejects private, loopback, and metadata IP literals by default", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1:8080/")).rejects.toThrow(
      /private or internal/,
    );
    await expect(assertSafeOutboundUrl("http://10.0.0.5/")).rejects.toThrow(
      /private or internal/,
    );
    await expect(assertSafeOutboundUrl("http://[::1]/")).rejects.toThrow(
      /private or internal/,
    );
    await expect(
      assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/metadata/);
  });

  it("allows private IPs with allowPrivate but still blocks metadata", async () => {
    await expect(
      assertSafeOutboundUrl("http://192.168.1.50:7912/api/v1/info", { allowPrivate: true }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeOutboundUrl("http://127.0.0.1:7125/server/info", { allowPrivate: true }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeOutboundUrl("http://169.254.169.254/", { allowPrivate: true }),
    ).rejects.toThrow(/metadata/);
  });

  it("resolves hostnames and applies the same rules", async () => {
    await expect(
      assertSafeOutboundUrl("https://example.com/image.png", { lookupFn: publicLookup }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeOutboundUrl("https://internal.example/x", { lookupFn: privateLookup }),
    ).rejects.toThrow(/private or internal/);
    await expect(
      assertSafeOutboundUrl("https://localhost.example/x", { lookupFn: loopbackLookup }),
    ).rejects.toThrow(/private or internal/);
    await expect(
      assertSafeOutboundUrl("http://spoolman.lan/api", {
        lookupFn: privateLookup,
        allowPrivate: true,
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects hostnames that fail to resolve", async () => {
    const failing: LookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      assertSafeOutboundUrl("https://nope.invalid/", { lookupFn: failing }),
    ).rejects.toThrow(/Could not resolve host/);
  });
});

describe("assertSafeOutboundHost", () => {
  it("allows private LAN hosts with allowPrivate", async () => {
    await expect(
      assertSafeOutboundHost("192.168.1.60", { allowPrivate: true }),
    ).resolves.toBe("192.168.1.60");
  });

  it("rejects host:port and metadata", async () => {
    await expect(
      assertSafeOutboundHost("192.168.1.60:8883", { allowPrivate: true }),
    ).rejects.toThrow(/port separately/);
    await expect(
      assertSafeOutboundHost("169.254.169.254", { allowPrivate: true }),
    ).rejects.toThrow(/metadata/);
  });
});

describe("safeOutboundFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks redirects to private addresses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 302,
        headers: { get: (k: string) => (k === "location" ? "http://127.0.0.1/secret" : null) },
      })),
    );
    await expect(
      safeOutboundFetch("https://example.com/img.png", {}, { lookupFn: publicLookup }),
    ).rejects.toThrow(/private or internal/);
  });

  it("follows safe redirects and returns the final response", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return {
            status: 301,
            headers: {
              get: (k: string) => (k === "location" ? "https://cdn.example.com/img.png" : null),
            },
          };
        }
        return { status: 200, ok: true, headers: { get: () => null } };
      }),
    );
    const res = await safeOutboundFetch(
      "https://example.com/img.png",
      {},
      { lookupFn: publicLookup },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});
