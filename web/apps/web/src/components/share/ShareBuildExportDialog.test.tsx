// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import ShareBuildExportDialog from "./ShareBuildExportDialog";

const auth = vi.hoisted(() => ({ multiUser: true }));
const health = vi.hoisted(() => ({ current: { capabilities: [] as string[] } }));

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ multiUser: auth.multiUser }),
}));
vi.mock("../../hooks/useEngineHealth", () => ({
  useEngineHealth: () => ({ health: health.current }),
}));
vi.mock("../../hooks/useJobRunner", () => ({
  useJobRunner: () => ({ busy: false, runJob: vi.fn() }),
}));
vi.mock("../../api/endpoints/board", () => ({
  createBoardPost: vi.fn(),
}));
vi.mock("../../api/endpoints/auth", () => ({
  createPlanShare: vi.fn(),
}));
vi.mock("../../api/endpoints/jobs", () => ({
  startExportKitBundle: vi.fn(),
}));
vi.mock("./ReferenceSharePanel", () => ({
  default: () => <div>Recipe preview</div>,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("ShareBuildExportDialog", () => {
  afterEach(cleanup);

  beforeEach(() => {
    auth.multiUser = true;
    health.current = { capabilities: [] };
  });

  it("keeps Kit export on self-host", () => {
    render(
      <MemoryRouter>
        <ShareBuildExportDialog open onOpenChange={() => undefined} profileId={3} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Share build")).toBeTruthy();
    expect(screen.getByText(/Legacy Kit export/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Post to the board" })).toBeNull();
  });

  it("posts to the board on hosted planning and hides Kit copies", () => {
    health.current = { capabilities: ["hosted_planning"] };
    render(
      <MemoryRouter>
        <ShareBuildExportDialog open onOpenChange={() => undefined} profileId={3} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Post to the board" })).toBeTruthy();
    expect(screen.queryByText(/Legacy Kit export/)).toBeNull();
    expect(screen.queryByText("Send to user")).toBeNull();
  });
});
