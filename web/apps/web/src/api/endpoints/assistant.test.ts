import { describe, expect, it, vi } from "vitest";
import { jsonResponse, createEndpointTestHttp } from "../endpointTestHttp";
import type { AssistantProposedAction } from "@print-partner/contracts";
import {
  applyAssistantAction,
  clearAssistantDecisions,
  clearAssistantFeedback,
  clearAssistantHistory,
  dismissAssistantAction,
  fetchAssistantFeedback,
  fetchAssistantHistory,
  fetchAssistantStatus,
  fetchPlanDecisions,
  postAssistantChat,
  postAssistantFeedback,
  streamAssistantChat,
} from "./assistant";

function streamResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

const http = createEndpointTestHttp();

describe("assistant endpoints", () => {
  it("fetches and clears assistant state", async () => {
    http
      .respond(jsonResponse({ enabled: true }))
      .respond(jsonResponse({ messages: [] }))
      .respond(jsonResponse({ ok: true }))
      .respond(
        jsonResponse({ ok: true, scope: "plan", plan_id: 7, deleted: 1 }),
      )
      .respond(jsonResponse({ ok: true, deleted: 2 }))
      .respond(jsonResponse({ entries: [] }))
      .respond(jsonResponse({ decisions: [] }));

    await fetchAssistantStatus();
    await fetchAssistantHistory();
    await clearAssistantHistory();
    await clearAssistantDecisions({ planId: 7 });
    await clearAssistantFeedback();
    await fetchAssistantFeedback();
    await fetchPlanDecisions(7);

    expect(http.calls[3]?.[0]).toContain("/assistant/decisions?plan_id=7");
    expect(http.calls[6]?.[0]).toContain("/plans/7/decisions");
  });

  it("posts feedback, actions, dismissals, and non-stream chat", async () => {
    const action: AssistantProposedAction = {
      id: "action-1",
      type: "ui_navigate",
      plan_id: 7,
      label: "Open Sources",
      summary: "Open Sources",
      params: { target: "sources" },
    };
    http
      .respond(jsonResponse({ ok: true, id: "feedback" }))
      .respond(jsonResponse({ ok: true }))
      .respond(jsonResponse({ ok: true }))
      .respond(jsonResponse({ message: { role: "assistant", content: "hi" } }));

    await postAssistantFeedback({
      rating: "up",
      message_excerpt: "good",
      plan_id: 7,
    });
    await applyAssistantAction(action);
    await dismissAssistantAction(action);
    await postAssistantChat({ messages: [], plan_id: 7 });

    expect(http.requestJson(0)).toEqual({
      rating: "up",
      message_excerpt: "good",
      plan_id: 7,
    });
    expect(http.requestJson(1)).toEqual({ action });
    expect(http.requestJson(2)).toEqual({ action });
    expect(http.requestJson(3)).toEqual({
      messages: [],
      plan_id: 7,
      stream: false,
    });
  });

  it("streams assistant chat SSE events", async () => {
    http.respond(
      streamResponse([
        'event: token\ndata: {"text":"Hel"}\n',
        'event: token\ndata: {"text":"lo"}\n',
        'event: meta\ndata: {"tools_degraded":true,"note":"slow"}\n',
        'event: done\ndata: {"final_content":"Hello"}\n',
      ]),
    );
    const tokens: string[] = [];
    const done = vi.fn();
    const meta = vi.fn();

    await streamAssistantChat(
      { messages: [], plan_id: 7 },
      {
        onToken: (text) => tokens.push(text),
        onDone: done,
        onError: vi.fn(),
        onMeta: meta,
      },
    );

    expect(tokens).toEqual(["Hel", "lo"]);
    expect(meta).toHaveBeenCalledWith({ tools_degraded: true, note: "slow" });
    expect(done).toHaveBeenCalledWith({
      final_content: "Hello",
      proposed_actions: undefined,
    });
    expect(http.requestJson(0)).toEqual({
      messages: [],
      plan_id: 7,
      stream: true,
    });
  });
});
