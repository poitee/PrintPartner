import { describe, expect, it } from "vitest";
import { passwordResetPublicOrigin } from "./password-reset-mail.js";

describe("passwordResetPublicOrigin", () => {
  const request = { protocol: "https", host: "request.example" } as const;

  it("uses the configured public URL for delivered email", () => {
    expect(passwordResetPublicOrigin({
      appPublicUrl: "https://print.example",
      smtpConfigured: true,
      passwordResetDevExpose: false,
    }, request)).toBe("https://print.example");
  });

  it("does not derive an emailed link from the request Host", () => {
    expect(passwordResetPublicOrigin({
      appPublicUrl: null,
      smtpConfigured: true,
      passwordResetDevExpose: false,
    }, request)).toBeNull();
  });

  it("allows request-origin links only for the explicit development response", () => {
    expect(passwordResetPublicOrigin({
      appPublicUrl: null,
      smtpConfigured: false,
      passwordResetDevExpose: true,
    }, request)).toBe("https://request.example");
    expect(passwordResetPublicOrigin({
      appPublicUrl: null,
      smtpConfigured: false,
      passwordResetDevExpose: false,
    }, request)).toBeNull();
  });
});
