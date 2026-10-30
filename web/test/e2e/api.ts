import { randomUUID } from "node:crypto";
import process from "node:process";
import { expect, type Page } from "@playwright/test";

// The gateway rejects writes without a same-origin Origin header. page.request shares the
// signed-in browser context, so these calls carry the bootstrap session cookie.
export async function api<T = unknown>(page: Page, path: string, method = "GET", data?: unknown): Promise<T> {
  const origin = process.env.PP_SERVER_URL;
  const response = await page.request.fetch(`${origin}${path}`, {
    method,
    headers: { Origin: origin!, Accept: "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": randomUUID() }) },
    ...(data === undefined ? {} : { data }),
  });
  const text = await response.text();
  expect(response.ok(), `${method} ${path}: ${response.status()} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : null) as T;
}
