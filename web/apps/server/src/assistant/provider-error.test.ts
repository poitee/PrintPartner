import { describe, expect, it } from "vitest";
import { formatProviderHttpError } from "./provider-error.js";

describe("formatProviderHttpError", () => {
  it("prefers structured error.message and includes status", () => {
    const msg = formatProviderHttpError(
      "Ollama",
      404,
      JSON.stringify({ error: { message: "model 'llama3.2' not found", type: "not_found_error" } }),
    );
    expect(msg).toBe("Ollama HTTP 404: model 'llama3.2' not found");
  });

  it("redacts bearer tokens and sk- keys from snippets", () => {
    const msg = formatProviderHttpError(
      "OpenAI-compatible",
      401,
      "Unauthorized Bearer sk-abc123deadbeef and api_key=secret-value",
    );
    expect(msg).toContain("HTTP 401");
    expect(msg).not.toContain("sk-abc");
    expect(msg).not.toContain("secret-value");
    expect(msg).toContain("[redacted]");
  });
});
