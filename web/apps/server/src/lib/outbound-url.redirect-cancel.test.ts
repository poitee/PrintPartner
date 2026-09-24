import { expect, it, vi } from "vitest";
import { fetch as undiciFetch, Response as UndiciResponse } from "undici";
import { safeOutboundFetch, type LookupFn } from "./outbound-url.js";

vi.mock("undici", async (importOriginal) => ({
  ...await importOriginal<typeof import("undici")>(),
  fetch: vi.fn(),
}));

it("follows a validated redirect when discarding its body fails", async () => {
  const redirect = new UndiciResponse("discard me", {
    status: 302,
    headers: { Location: "/final" },
  });
  const cancel = vi.fn(async () => { throw new Error("body already failed"); });
  Object.defineProperty(redirect.body, "cancel", { value: cancel });
  vi.mocked(undiciFetch)
    .mockResolvedValueOnce(redirect)
    .mockResolvedValueOnce(new UndiciResponse("final body"));
  const lookupFn: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];

  const response = await safeOutboundFetch("http://connector.test/start", {}, {
    allowPrivate: true,
    lookupFn,
  });

  expect(cancel).toHaveBeenCalledOnce();
  expect(undiciFetch).toHaveBeenCalledTimes(2);
  expect(await response.text()).toBe("final body");
});
