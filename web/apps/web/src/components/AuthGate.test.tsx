// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import AuthGate from "./AuthGate";

vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ user: null, multiUser: true, loading: false }),
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
});
