import type { FastifyBaseLogger } from "fastify";
import nodemailer from "nodemailer";
import type { ServerConfig } from "../config.js";

export type PasswordResetDelivery = {
  sent: boolean;
  devResetUrl?: string;
};

export function buildPasswordResetUrl(publicOrigin: string, rawToken: string): string {
  const base = publicOrigin.replace(/\/$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

export function requestPublicOrigin(headers: {
  "x-forwarded-proto"?: string;
  "x-forwarded-host"?: string;
  host?: string;
}): string {
  const protoHeader = headers["x-forwarded-proto"];
  const proto = protoHeader?.split(",")[0]?.trim() || "http";
  const hostHeader = headers["x-forwarded-host"] ?? headers.host ?? "localhost:8080";
  const host = hostHeader.split(",")[0]?.trim() || "localhost:8080";
  return `${proto}://${host}`;
}

export async function deliverPasswordResetEmail(
  config: ServerConfig,
  log: FastifyBaseLogger,
  input: { to: string; resetUrl: string },
): Promise<PasswordResetDelivery> {
  const subject = "Reset your Print Partner password";
  const text = [
    "You requested a password reset for your Print Partner account.",
    "",
    `Open this link to choose a new password (valid for 1 hour):`,
    input.resetUrl,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  if (config.smtpConfigured && config.smtpFrom) {
    const transport = nodemailer.createTransport({
      host: config.smtpHost!,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth:
        config.smtpUser && config.smtpPass
          ? { user: config.smtpUser, pass: config.smtpPass }
          : undefined,
    });
    await transport.sendMail({
      from: config.smtpFrom,
      to: input.to,
      subject,
      text,
    });
    return { sent: true };
  }

  log.warn(
    { to: input.to, resetUrl: input.resetUrl },
    "SMTP not configured — password reset link logged (set SMTP_HOST and SMTP_FROM to send email)",
  );

  if (config.passwordResetDevExpose) {
    return { sent: false, devResetUrl: input.resetUrl };
  }
  return { sent: false };
}
