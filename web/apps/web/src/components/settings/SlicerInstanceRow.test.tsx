// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SlicerInstanceRow from "./SlicerInstanceRow";

afterEach(cleanup);

describe("SlicerInstanceRow", () => {
  it("names the editable instance name and enabled switch", () => {
    render(
      <SlicerInstanceRow
        row={{
          id: "orca-default",
          name: "Orca",
          kind: "orca",
          dialect: "orca_json",
          gui_url: "",
          watch_path: "",
          docker_target: "",
          docker_host: null,
          compose_service: null,
          image: null,
          container_name: null,
          status_cache: "unknown",
          status_message: null,
          enabled: true,
          created_at: "2026-09-04T00:00:00.000Z",
          updated_at: "2026-09-04T00:00:00.000Z",
        }}
        busy={false}
        controlsDisabled={false}
        dockerEnabled={false}
        logs={undefined}
        onToggle={vi.fn()}
        onSaveField={vi.fn()}
        onDelete={vi.fn()}
        onDocker={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Name for Orca" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Orca enabled" })).toBeTruthy();
  });
});
