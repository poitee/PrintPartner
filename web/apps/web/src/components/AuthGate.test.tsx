// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthGate from "./AuthGate";

const authState = vi.hoisted(() => ({
  user: null,
  multiUser: true,
  authRequired: true,
  registrationOpen: false,
  loading: false,
}));

vi.mock("../context/AuthContext", () => ({
  useAuth: () => authState,
}));

function LoginLocation() {
  const location = useLocation();
  const from =
    typeof location.state === "object" &&
    location.state !== null &&
    "from" in location.state &&
    typeof location.state.from === "string"
      ? location.state.from
      : undefined;
  return <output>{from}</output>;
}

describe("AuthGate", () => {
  afterEach(cleanup);
  beforeEach(() => {
    authState.multiUser = true;
    authState.registrationOpen = false;
  });

  it("preserves path, search, and hash in the post-login return target", () => {
    render(
      <MemoryRouter initialEntries={["/settings?mode=advanced#printers"]}>
        <Routes>
          <Route path="/login" element={<LoginLocation />} />
          <Route element={<AuthGate />}>
            <Route path="/settings" element={<h1>Settings</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toBe("/settings?mode=advanced#printers");
  });

  it("sends an unconfigured single-user installation to setup", () => {
    authState.multiUser = false;
    authState.registrationOpen = true;
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/setup" element={<h1>Setup</h1>} />
          <Route element={<AuthGate />}>
            <Route path="/" element={<h1>Home</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Setup" })).toBeTruthy();
  });
});
