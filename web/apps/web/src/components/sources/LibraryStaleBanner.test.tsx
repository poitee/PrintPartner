// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import LibraryStaleBanner from "./LibraryStaleBanner";

afterEach(cleanup);

describe("LibraryStaleBanner", () => {
  it("says nothing when no source has moved", () => {
    const { container } = render(
      <LibraryStaleBanner staleCount={0} onSeeChanges={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("announces the count and offers one named action", async () => {
    const onSeeChanges = vi.fn();
    render(
      <LibraryStaleBanner staleCount={3} attachedStaleCount={1} onSeeChanges={onSeeChanges} />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("3 sources moved upstream.");
    expect(alert.textContent).toContain("1 of them is in your plan.");

    const action = screen.getByRole("button", { name: "View synced docs" });
    await userEvent.click(action);
    expect(onSeeChanges).toHaveBeenCalledTimes(1);
  });

  it("falls back to the general warning when nothing stale is attached", () => {
    render(<LibraryStaleBanner staleCount={1} onSeeChanges={vi.fn()} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("1 source moved upstream.");
    expect(alert.textContent).toContain("Your plan may still use older files.");
  });
});
