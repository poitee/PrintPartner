import { describe, expect, it } from "vitest";
import {
  bambuConnectDisplayName,
  bambuConnectLaunchCommand,
  buildBambuConnectUrl,
  isAllowedBambuConnectFilename,
  resolveBambuConnectHostPath,
  sanitizeBambuConnectFilename,
} from "./bambu-connect.js";

describe("bambu-connect", () => {
  it("accepts Bambu Connect file types", () => {
    expect(isAllowedBambuConnectFilename("plate.gcode.3mf")).toBe(true);
    expect(isAllowedBambuConnectFilename("plate.3mf")).toBe(true);
    expect(isAllowedBambuConnectFilename("job.gcode")).toBe(true);
    expect(isAllowedBambuConnectFilename("job.bgcode")).toBe(false);
  });

  it("sanitizes path segments out of filenames", () => {
    expect(sanitizeBambuConnectFilename("../../x.3mf")).toBe("x.3mf");
    expect(bambuConnectDisplayName("Cube.gcode.3mf")).toBe("Cube");
  });

  it("builds the official import-file URL scheme", () => {
    const url = buildBambuConnectUrl("/tmp/cube.gcode.3mf", "Cube");
    expect(url.startsWith("bambu-connect://import-file?")).toBe(true);
    const qs = new URL(url.replace("bambu-connect://", "https://x/")).searchParams;
    expect(qs.get("path")).toBe("/tmp/cube.gcode.3mf");
    expect(qs.get("name")).toBe("Cube");
    expect(qs.get("version")).toBe("1.0.0");
  });

  it("maps container paths when BAMBU_CONNECT_HOST_PATH_MAP is set", () => {
    const prev = process.env.BAMBU_CONNECT_HOST_PATH_MAP;
    process.env.BAMBU_CONNECT_HOST_PATH_MAP = "/data=/Users/me/pp-data";
    try {
      expect(resolveBambuConnectHostPath("/data/exports/a.3mf")).toBe(
        "/Users/me/pp-data/exports/a.3mf",
      );
      expect(resolveBambuConnectHostPath("/data")).toBe("/Users/me/pp-data");
      expect(resolveBambuConnectHostPath("/database/a.3mf")).toBe("/database/a.3mf");
      expect(resolveBambuConnectHostPath("/other/a.3mf")).toBe("/other/a.3mf");
    } finally {
      if (prev == null) delete process.env.BAMBU_CONNECT_HOST_PATH_MAP;
      else process.env.BAMBU_CONNECT_HOST_PATH_MAP = prev;
    }
  });

  it("strips control characters from filenames", () => {
    expect(sanitizeBambuConnectFilename("bad\nname.3mf")).toBe("badname.3mf");
  });

  it("preserves URL query ampersands on Windows launch", () => {
    const url = buildBambuConnectUrl("/tmp/cube.gcode.3mf", "Cube");
    expect(url).toContain("&");
    const { cmd, args } = bambuConnectLaunchCommand(url, "win32");
    expect(cmd).toBe("rundll32");
    expect(args).toEqual(["url.dll,FileProtocolHandler", url]);
    expect(args[1]).toContain("&");
  });
});
