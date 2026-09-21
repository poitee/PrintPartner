// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import BoardPage from "./BoardPage";

const board = vi.hoisted(() => ({
  fetchBoardPosts: vi.fn(),
  fetchBoardPost: vi.fn(),
  createBoardComment: vi.fn(),
  deleteBoardComment: vi.fn(),
  hideBoardPost: vi.fn(),
}));

vi.mock("../api/endpoints/board", () => board);
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({
    user: { user_id: "u1", is_admin: false, display_name: "Bev" },
  }),
}));
vi.mock("../context/DateFormatContext", () => ({
  useDateFormat: () => ({ formatDate: (value: string) => value }),
}));

const postDetail = {
  post: {
    id: "p1",
    author_user_id: "ada",
    author_display_name: "Ada",
    caption: "First recipe",
    title: "Board Build",
    cover_url: null,
    created_at: "2026-09-13T00:00:00Z",
    snapshot: {
      format: "printpartner-reference-share",
      version: 1,
      kind: "build",
      title: "Board Build",
      sources: [
        {
          key: "source-1",
          name: "Voron",
          location: { kind: "publisher", url: "https://github.com/VoronDesign/Voron-2" },
          revision: { branch: "main", tag: null, commit: null },
          file_rules: [],
        },
      ],
      layers: [],
      selections: {},
      include: [],
      exclude: [],
      replacements: {},
      parts: [],
    },
  },
  comments: [],
};

describe("BoardPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists newest posts without an add-to-builds action", async () => {
    board.fetchBoardPosts.mockResolvedValue({
      posts: [
        {
          id: "p1",
          author_display_name: "Ada",
          caption: "First recipe",
          title: "Board Build",
          cover_url: null,
          created_at: "2026-09-13T00:00:00Z",
        },
      ],
    });
    render(
      <MemoryRouter initialEntries={["/board"]}>
        <Routes>
          <Route path="/board" element={<BoardPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("First recipe")).toBeTruthy();
    expect(screen.getByText("Board Build")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to my Builds" })).toBeNull();
  });

  it("disables Add to my Builds and explains mapping", async () => {
    board.fetchBoardPost.mockResolvedValue(postDetail);
    render(
      <MemoryRouter initialEntries={["/board/p1"]}>
        <Routes>
          <Route path="/board/:postId" element={<BoardPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("First recipe")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to my Builds" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/waiting on Source mapping/i)).toBeTruthy();
    await waitFor(() => {
      expect(board.fetchBoardPost).toHaveBeenCalledWith("p1");
    });
  });

  it("clears a comment error when posting again", async () => {
    board.fetchBoardPost.mockResolvedValue(postDetail);
    board.createBoardComment
      .mockRejectedValueOnce(new Error("Comment failed"))
      .mockResolvedValueOnce({
        comment: {
          id: "c1",
          author_user_id: "u1",
          author_display_name: "Bev",
          body: "I will sync this in my Library",
          created_at: "2026-09-13T00:01:00Z",
        },
      });
    render(
      <MemoryRouter initialEntries={["/board/p1"]}>
        <Routes>
          <Route path="/board/:postId" element={<BoardPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("First recipe")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Comment"), {
      target: { value: "I will sync this in my Library" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Comment failed");
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(screen.getByText("I will sync this in my Library")).toBeTruthy();
  });
  it("clears a deletion error after retrying successfully", async () => {
    board.fetchBoardPost.mockResolvedValue({
      ...postDetail,
      comments: [{
        id: "c1", author_user_id: "u1", author_display_name: "Bev",
        body: "Remove this comment", created_at: "2026-09-13T00:01:00Z",
      }],
    });
    board.deleteBoardComment
      .mockRejectedValueOnce(new Error("Delete failed"))
      .mockResolvedValueOnce({ ok: true });
    render(
      <MemoryRouter initialEntries={["/board/p1"]}>
        <Routes><Route path="/board/:postId" element={<BoardPage />} /></Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Delete failed");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Remove this comment")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

});
