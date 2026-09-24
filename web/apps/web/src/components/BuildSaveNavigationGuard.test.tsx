// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, Link, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import BuildSaveNavigationGuard from "./BuildSaveNavigationGuard";

const saves = vi.hoisted(() => ({ flush: vi.fn<() => Promise<void>>() }));
vi.mock("../hooks/useFlushBuildPageSaves", () => ({
  useFlushBuildPageSaves: () => saves.flush,
}));

function renderRoutes(initialEntries = ["/builds", "/sources"], initialIndex = 1) {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <BuildSaveNavigationGuard />
            <LocationProbe />
          </>
        ),
      },
    ],
    { initialEntries, initialIndex },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <h1>{location.pathname}</h1>
      <Link to="/builds">Builds link</Link>
      <button onClick={() => navigate("/builds")}>Builds button</button>
    </>
  );
}

describe("BuildSaveNavigationGuard", () => {
  afterEach(() => {
    cleanup();
    saves.flush.mockReset();
  });

  it("holds browser Back until a pending save finishes", async () => {
    let resolveSave!: () => void;
    saves.flush.mockReturnValue(new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    const router = renderRoutes();
    act(() => {
      void router.navigate(-1);
    });
    expect(router.state.location.pathname).toBe("/sources");
    expect(saves.flush).toHaveBeenCalledTimes(1);
    resolveSave();
    await waitFor(() => expect(router.state.location.pathname).toBe("/builds"));
  });

  it("keeps Sources open when a save fails and allows a later retry", async () => {
    saves.flush.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const router = renderRoutes();
    act(() => {
      void router.navigate(-1);
    });
    await waitFor(() => expect(saves.flush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect([...router.state.blockers.values()][0]?.state).toBe("unblocked"));
    expect(router.state.location.pathname).toBe("/sources");
    act(() => {
      void router.navigate(-1);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/builds"));
  });

  it("holds Forward, links, and programmatic navigation", async () => {
    for (const navigation of ["forward", "link", "button"] as const) {
      saves.flush.mockReset();
      let resolveSave!: () => void;
      saves.flush.mockReturnValue(new Promise<void>((resolve) => {
        resolveSave = resolve;
      }));
      const router = navigation === "forward"
        ? renderRoutes(["/sources", "/builds"], 0)
        : renderRoutes(["/sources"], 0);
      if (navigation === "forward") {
        act(() => {
          void router.navigate(1);
        });
      } else {
        fireEvent.click(screen.getByRole(navigation === "link" ? "link" : "button", {
          name: navigation === "link" ? "Builds link" : "Builds button",
        }));
      }
      expect(router.state.location.pathname).toBe("/sources");
      expect(saves.flush).toHaveBeenCalledTimes(1);
      resolveSave();
      await waitFor(() => expect(router.state.location.pathname).toBe("/builds"));
      cleanup();
    }
  });

  it("flushes Plan choices before leaving but ignores unrelated query changes", async () => {
    saves.flush.mockResolvedValue(undefined);
    const router = renderRoutes(["/plan?profile=1"], 0);
    act(() => {
      void router.navigate("/plan?profile=1&tab=parts");
    });
    await waitFor(() => expect(router.state.location.search).toBe("?profile=1&tab=parts"));
    expect(saves.flush).not.toHaveBeenCalled();
    act(() => {
      void router.navigate("/builds");
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/builds"));
    expect(saves.flush).toHaveBeenCalledTimes(1);
  });

  it("keeps the original Build on a failed same-route profile switch", async () => {
    saves.flush.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const router = renderRoutes(["/sources?profile=1"], 0);
    act(() => {
      void router.navigate("/sources?profile=2");
    });
    await waitFor(() => expect([...router.state.blockers.values()][0]?.state).toBe("unblocked"));
    expect(router.state.location.search).toBe("?profile=1");
    act(() => {
      void router.navigate("/sources?profile=2");
    });
    await waitFor(() => expect(router.state.location.search).toBe("?profile=2"));
    expect(saves.flush).toHaveBeenCalledTimes(2);
  });
});
