import { resolveEngineUrl } from "../contractRequest";
import { engineFetch } from "../engineTransport";

export type AuthUser = {
  user_id: string;
  login: string;
  display_name: string;
  email: string | null;
  provider: string;
  is_admin: boolean;
};

export type IncomingShare = {
  id: string;
  token: string;
  plan_name: string;
  from_display_name: string;
  recipient_email: string | null;
  created_at: string;
};

export function authOAuthUrl(provider: "github" | "discord"): string {
  return resolveEngineUrl(provider === "github" ? "/auth/github" : "/auth/discord");
}

export async function fetchAuthMe(): Promise<{ user: AuthUser; multi_user: boolean }> {
  return engineFetch<{ user: AuthUser; multi_user: boolean }>("/auth/me");
}

export async function loginWithEmail(
  email: string,
  password: string,
): Promise<{ user: AuthUser }> {
  return engineFetch<{ user: AuthUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function registerWithEmail(
  email: string,
  password: string,
  display_name: string,
): Promise<{ user: AuthUser }> {
  return engineFetch<{ user: AuthUser }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, display_name }),
  });
}

export async function logout(): Promise<void> {
  await engineFetch<{ ok: boolean }>("/auth/logout", { method: "POST" });
}

export async function requestPasswordReset(
  email: string,
): Promise<{ ok: boolean; message: string; dev_reset_url?: string }> {
  return engineFetch("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function resetPasswordWithToken(
  token: string,
  password: string,
): Promise<{ ok: boolean; user: AuthUser }> {
  return engineFetch("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean }> {
  return engineFetch("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  });
}

export async function createPlanShare(
  profileId: number,
  input: { recipient_email?: string | null; include_print_progress?: boolean },
): Promise<{ share_id: string; token: string; plan_name: string }> {
  return engineFetch(`/plans/${profileId}/shares`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchIncomingShares(): Promise<{ shares: IncomingShare[] }> {
  return engineFetch("/shares/incoming");
}

export async function acceptPlanShare(
  token: string,
  newName?: string | null,
): Promise<{ profile_id: number; profile_name: string }> {
  return engineFetch(`/shares/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    body: JSON.stringify({ new_name: newName ?? null }),
  });
}

export async function revokePlanShare(shareId: string): Promise<void> {
  await engineFetch(`/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" });
}
