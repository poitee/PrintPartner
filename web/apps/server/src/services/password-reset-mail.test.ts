import Fastify from "fastify";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import {
  deliverPasswordResetEmail,
  passwordResetPublicOrigin,
} from "./password-reset-mail.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("deliverPasswordResetEmail", () => {
  it("composes the SMTP reset message without sending to a real server", async () => {
    const app = Fastify();
    const jsonTransport = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = vi.spyOn(jsonTransport, "sendMail");
    const createTransport = vi
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue(jsonTransport);
    const config = {
      ...loadConfig(),
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpUser: "mailer",
      smtpPass: "runtime-secret",
      smtpFrom: "Print Partner <noreply@example.test>",
      smtpSecure: true,
      smtpConfigured: true,
    };

    const delivery = await deliverPasswordResetEmail(config, app.log, {
      to: "maker@example.test",
      resetUrl: "https://print.example.test/reset-password?token=abc123",
    });

    expect(delivery).toEqual({ sent: true });
    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      auth: { user: "mailer", pass: "runtime-secret" },
    });
    expect(sendMail).toHaveBeenCalledOnce();
    const info = await sendMail.mock.results[0]!.value;
    expect(JSON.parse(info.message)).toMatchObject({
      from: { address: "noreply@example.test", name: "Print Partner" },
      to: [{ address: "maker@example.test", name: "" }],
      subject: "Reset your Print Partner password",
      text: expect.stringContaining(
        "https://print.example.test/reset-password?token=abc123",
      ),
    });
    await app.close();
  });
});
