import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { sendAcceptedFilamentFailure } from "./accepted-filament-failure.js";

function replyMock() {
  const reply = {
    status: vi.fn(),
    send: vi.fn(),
  };
  reply.status.mockReturnValue(reply);
  return reply;
}

describe("sendAcceptedFilamentFailure", () => {
  it("sends accepted state failures with the shared detail", () => {
    const reply = replyMock();

    sendAcceptedFilamentFailure(reply as unknown as FastifyReply, {
      kind: "accepted_state_unavailable",
      reason: "uninitialized",
    });

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({
      detail: "Accepted Plan operational state is not initialized",
    });
  });

  it("sends transaction failures as unavailable", () => {
    const reply = replyMock();

    sendAcceptedFilamentFailure(reply as unknown as FastifyReply, {
      kind: "transaction_unavailable",
    });

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ detail: "Accepted Plan update is unavailable" });
  });

  it("rejects success results", () => {
    expect(() =>
      sendAcceptedFilamentFailure(replyMock() as unknown as FastifyReply, {
        kind: "updated",
        unchanged: true,
        part: null,
        assigned: [],
      }),
    ).toThrow("Accepted filament success cannot be sent as a failure");
  });
});
