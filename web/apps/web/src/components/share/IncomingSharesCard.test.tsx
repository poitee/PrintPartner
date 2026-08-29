// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import IncomingSharesCard from "./IncomingSharesCard";

const auth = vi.hoisted(() => ({ multiUser: false }));
const shares = vi.hoisted(() => ({
  items: [] as Array<{
    id: string;
    token: string;
    plan_name: string;
    from_display_name: string;
    recipient_email: string | null;
    created_at: string;
  }>,
}));

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ multiUser: auth.multiUser }),
}));
vi.mock("@/context/ProfileContext", () => ({
  useProfileSelection: () => ({
    reloadProfiles: vi.fn(),
    setSelectedProfileId: vi.fn(),
  }),
}));
vi.mock("@/api/endpoints/auth", () => ({
  fetchIncomingShares: vi.fn(async () => ({ shares: shares.items })),
  acceptPlanShare: vi.fn(),
}));

describe("IncomingSharesCard", () => {
  afterEach(cleanup);

  beforeEach(() => {
    auth.multiUser = false;
    shares.items = [];
  });

  it("stays hidden for a single-user deployment", () => {
    const { container } = render(
      <MemoryRouter>
        <IncomingSharesCard />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe("");
  });

  it("lists a shared build waiting to be accepted", async () => {
    auth.multiUser = true;
    shares.items = [
      {
        id: "s1",
        token: "tok",
        plan_name: "Stealthburner",
        from_display_name: "Ada",
        recipient_email: null,
        created_at: "2026-08-29T00:00:00Z",
      },
    ];

    render(
      <MemoryRouter>
        <IncomingSharesCard />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Stealthburner")).toBeTruthy();
    expect(screen.getByText(/From Ada/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept copy" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).toBeNull();
    });
  });
});
