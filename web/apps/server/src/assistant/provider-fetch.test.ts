import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { fetchAssistantProvider } from "./provider-fetch.js";

describe("fetchAssistantProvider", () => {
  it("streams a local provider response through the checked connector", async () => {
    const server = createServer((_request, response) => {
      response.write("first");
      setTimeout(() => response.end(" second"), 10);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");

    try {
      const response = await fetchAssistantProvider(`http://127.0.0.1:${address.port}/`, {
        method: "POST",
        body: "{}",
        headers: { Authorization: "Bearer test-token" },
      });
      expect(await response.text()).toBe("first second");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it("does not follow provider redirects with credentials", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(302, { Location: "/other" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");

    try {
      const response = await fetchAssistantProvider(`http://127.0.0.1:${address.port}/`, {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(response.status).toBe(302);
      await response.body?.cancel();
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });
});
