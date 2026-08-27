import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import { uploadKitBundle } from "./imports";

const http = createEndpointTestHttp();

describe("kit import endpoints", () => {
  it("uploads kit bundles and trims optional imported Plan names", async () => {
    http.respond(
      jsonResponse({
        profile_id: 7,
        profile_name: "Imported",
        parts_imported: 1,
        layers_imported: 1,
      }),
    );

    const result = await uploadKitBundle(
      new File(["zip"], "kit.zip"),
      " Imported ",
    );

    expect(result.profile_name).toBe("Imported");
    expect(http.request(0).method).toBe("POST");
    expect(http.requestForm(0).get("new_name")).toBe("Imported");
  });

  it("surfaces upload error details", async () => {
    http.respond(jsonResponse({ detail: "Nope" }, 400));

    await expect(uploadKitBundle(new File(["zip"], "kit.zip"))).rejects.toThrow(
      "Nope",
    );
  });
});
