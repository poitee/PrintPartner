import { afterEach, describe, expect, it, vi } from "vitest";
import { setEngineUnauthorizedHandler } from "./contractRequest";
import {
  EngineHttpError,
  engineFetchMultipart,
  engineFetchStream,
  engineSendMultipart,
} from "./engineTransport";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
  setEngineUnauthorizedHandler(null);
});

describe("engine transport", () => {
  it("sends multipart requests with credentials and preserves caller headers", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    const form = new FormData();
    form.append("name", "plate");

    await expect(
      engineFetchMultipart<{ ok: boolean }>({
        path: "/uploads",
        form,
        headers: { "If-Match": '"basis"' },
      }),
    ).resolves.toEqual({ ok: true });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("include");
    expect(init?.body).toBe(form);
    expect(new Headers(init?.headers).get("If-Match")).toBe('"basis"');
    expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
  });

  it("centralizes unauthorized handling for streamed responses", async () => {
    const unauthorized = vi.fn();
    setEngineUnauthorizedHandler(unauthorized);
    fetchMock.mockResolvedValueOnce(Response.json({ detail: "Sign in" }, { status: 401 }));

    await expect(
      engineFetchStream({ path: "/assistant/chat", method: "POST" }),
    ).rejects.toEqual(expect.objectContaining<Partial<EngineHttpError>>({ status: 401 }));
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("accepts an empty successful response for multipart commands", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      engineSendMultipart({ path: "/parts/7/thumbnail", form: new FormData() }),
    ).resolves.toBeUndefined();
  });
});
