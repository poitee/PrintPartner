// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBadge } from "./status-badge";
import { WORKFLOW_STATUS_KINDS, workflowStatusPresentation } from "@/lib/statusTone";

describe("StatusBadge", () => {
  afterEach(cleanup);

  it("renders words and a shape for every workflow state", () => {
    for (const kind of WORKFLOW_STATUS_KINDS) {
      const { container } = render(<StatusBadge status={kind} />);
      const chip = container.querySelector(`[data-status="${kind}"]`);
      expect(chip, kind).toBeTruthy();
      expect(chip?.textContent?.trim()).toBe(workflowStatusPresentation(kind).label);
      expect(chip?.querySelector("svg"), `${kind} needs an icon`).toBeTruthy();
      cleanup();
    }
  });

  it("keeps a caller label instead of the default words", () => {
    render(<StatusBadge status="in_progress" label="2 jobs printing" />);

    expect(screen.getByText("2 jobs printing")).toBeTruthy();
  });

  it("announces politely for progress and urgently for errors", () => {
    const { container } = render(
      <>
        <StatusBadge status="in_progress" live />
        <StatusBadge status="error" live />
      </>,
    );

    expect(container.querySelector('[data-status="in_progress"]')?.getAttribute("role")).toBe(
      "status",
    );
    expect(container.querySelector('[data-status="error"]')?.getAttribute("role")).toBe("alert");
  });

  it("stays silent for assistive tech unless the caller asks", () => {
    const { container } = render(<StatusBadge status="complete" />);

    expect(container.querySelector('[data-status="complete"]')?.hasAttribute("role")).toBe(false);
  });
});
