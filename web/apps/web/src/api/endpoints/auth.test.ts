import { describe, expect, it } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import {
  acceptPlanShare,
  authOAuthUrl,
  changePassword,
  createPlanShare,
  fetchAuthMe,
  loginWithEmail,
  logout,
  registerWithEmail,
  requestPasswordReset,
  resetPasswordWithToken,
  revokePlanShare,
} from "./auth";

const http = createEndpointTestHttp();

describe("auth endpoints", () => {
  it("builds OAuth URLs", () => {
    expect(authOAuthUrl("github")).toContain("/auth/github");
    expect(authOAuthUrl("discord")).toContain("/auth/discord");
  });

  it("fetches the current auth session", async () => {
    http.respond(jsonResponse({ user: null, multi_user: false }));

    await expect(fetchAuthMe()).resolves.toEqual({
      user: null,
      multi_user: false,
    });
    expect(http.calls[0]?.[0]).toContain("/auth/me");
  });

  it("sends auth mutation payloads", async () => {
    http
      .respond(jsonResponse({ user: { user_id: "u" } }))
      .respond(jsonResponse({ user: { user_id: "u" } }))
      .respond(jsonResponse({ ok: true }))
      .respond(jsonResponse({ ok: true, message: "sent" }))
      .respond(jsonResponse({ ok: true, user: { user_id: "u" } }))
      .respond(jsonResponse({ ok: true }));

    await loginWithEmail("a@example.test", "pw");
    await registerWithEmail("b@example.test", "pw2", "Bea");
    await logout();
    await requestPasswordReset("c@example.test");
    await resetPasswordWithToken("token", "pw3");
    await changePassword("old", "new");

    expect(http.requestJson(0)).toEqual({
      email: "a@example.test",
      password: "pw",
    });
    expect(http.requestJson(1)).toEqual({
      email: "b@example.test",
      password: "pw2",
      display_name: "Bea",
    });
    expect(http.calls[2]?.[0]).toContain("/auth/logout");
    expect(http.requestJson(3)).toEqual({ email: "c@example.test" });
    expect(http.requestJson(4)).toEqual({ token: "token", password: "pw3" });
    expect(http.requestJson(5)).toEqual({
      current_password: "old",
      new_password: "new",
    });
  });

  it("sends share requests", async () => {
    http
      .respond(jsonResponse({ share_id: "s", token: "t", plan_name: "Plan" }))
      .respond(jsonResponse({ profile_id: 4, profile_name: "Copy" }))
      .respond(jsonResponse({ ok: true }));

    await createPlanShare(7, {
      recipient_email: "x@example.test",
      include_print_progress: true,
    });
    await acceptPlanShare("tok/en", "Copy");
    await revokePlanShare("share/id");

    expect(http.calls[0]?.[0]).toContain("/plans/7/shares");
    expect(http.requestJson(0)).toEqual({
      recipient_email: "x@example.test",
      include_print_progress: true,
    });
    expect(http.calls[1]?.[0]).toContain("/shares/tok%2Fen/accept");
    expect(http.requestJson(1)).toEqual({ new_name: "Copy" });
    expect(http.calls[2]?.[0]).toContain("/shares/share%2Fid");
  });
});
