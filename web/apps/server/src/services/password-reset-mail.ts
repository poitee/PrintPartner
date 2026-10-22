import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import nodemailer from "nodemailer";
import type { ServerConfig } from "../config.js";

type PasswordResetDelivery = {
  sent: boolean;
  devResetUrl?: string;
  errorClass?:
    | "client"
    | "smtp_permanent"
    | "smtp_response"
    | "smtp_transient"
    | "timeout"
    | "tls"
    | "transport";
};

function resetMailErrorClass(error: unknown): NonNullable<PasswordResetDelivery["errorClass"]> {
  if (!error || typeof error !== "object") return "transport";
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const responseCode =
    typeof record.responseCode === "number" && Number.isFinite(record.responseCode)
      ? record.responseCode
      : typeof record.responseCode === "string" && /^[1-9][0-9]{2}$/.test(record.responseCode)
        ? Number(record.responseCode)
        : 0;
  if (code === "ETIMEDOUT" || code === "ETIMEOUT") return "timeout";
  if (code === "ETLS") return "tls";
  if (responseCode >= 500) return "smtp_permanent";
  if (responseCode >= 400) return "smtp_transient";
  if (code === "EAUTH") return "client";
  if (responseCode > 0) return "smtp_response";
  return "transport";
}

export function buildPasswordResetUrl(publicOrigin: string, rawToken: string): string {
  const base = publicOrigin.replace(/\/$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

type PasswordResetOriginConfig = Pick<
  ServerConfig,
  "appPublicUrl" | "passwordResetDevExpose" | "smtpConfigured"
>;

export function passwordResetPublicOrigin(
  config: PasswordResetOriginConfig,
  request: Pick<FastifyRequest, "host" | "protocol">,
): string | null {
  if (config.appPublicUrl) return config.appPublicUrl;
  if (config.smtpConfigured || !config.passwordResetDevExpose) return null;
  return `${request.protocol}://${request.host}`;
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
    try {
      await transport.sendMail({
        from: config.smtpFrom,
        to: input.to,
        subject,
        text,
      });
    } catch (error) {
      return { sent: false, errorClass: resetMailErrorClass(error) };
    }
    return { sent: true };
  }

  if (config.passwordResetDevExpose) {
    log.warn(
      { to: input.to, resetUrl: input.resetUrl },
      "SMTP not configured; development password reset link logged",
    );
    return { sent: false, devResetUrl: input.resetUrl };
  }
  log.warn(
    { to: input.to },
    "SMTP not configured; password reset email was not sent",
  );
  return { sent: false };
}
