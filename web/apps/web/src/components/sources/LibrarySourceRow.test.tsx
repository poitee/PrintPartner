// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSummary } from "@print-partner/contracts";
import type { LibraryCardMeta } from "../../lib/librarySourceMeta";
import LibrarySourceRow from "./LibrarySourceRow";

const source = {
  id: 7,
  name: "Voron Trident",
  url: "https://example.com/voron.git",
  source_kind: "github",
  source_type: "git",
  role: "unassigned",
  category: "Printers/Voron",
  branch: "main",
  tag: null,
  local_path: null,
  last_synced_at: null,
  last_commit_sha: null,
  current_source_revision_id: null,
  docs_url: null,
  manifest_community_slug: null,
  metadata: null,
} satisfies SourceSummary;

const meta = {
  slug: "example.com/voron.git",
  stateLabel: "Ready",
  stateTone: "success",
  pickLabel: "3 picks",
  barPct: 100,
  barTone: "default",
  borderTone: "default",
} satisfies LibraryCardMeta;

describe("LibrarySourceRow", () => {
  afterEach(cleanup);

  it("opens the source from the main row action", () => {
    const onOpen = vi.fn();

    render(
      <LibrarySourceRow
        source={source}
        meta={meta}
        categories={["Printers/Voron"]}
        busy={false}
        selected={false}
        onOpen={onOpen}
        onEdit={vi.fn()}
        onSync={vi.fn()}
        onUpload={vi.fn()}
        onDelete={vi.fn()}
        onAssignCategory={vi.fn()}
        onSelectClick={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /Voron Trident/ })[0]!);

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("passes selection modifiers from the checkbox", () => {
    const onSelectClick = vi.fn();

    render(
      <LibrarySourceRow
        source={source}
        meta={meta}
        categories={[]}
        busy={false}
        selected
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onSync={vi.fn()}
        onUpload={vi.fn()}
        onDelete={vi.fn()}
        onAssignCategory={vi.fn()}
        onSelectClick={onSelectClick}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Voron Trident" }), {
      shiftKey: true,
    });

    expect(onSelectClick).toHaveBeenCalledWith({
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
    });
  });
});
