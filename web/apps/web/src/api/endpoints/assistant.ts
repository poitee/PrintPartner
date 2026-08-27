import type {
  AssistantActionApplyResponse,
  AssistantChatMessage,
  AssistantChatResponse,
  AssistantFeedbackRating,
  AssistantHistoryResponse,
  AssistantProposedAction,
  AssistantStatus,
  PlanDecision,
} from "@print-partner/contracts";
import { EngineHttpError, engineFetch, engineFetchStream } from "../engineTransport";

export type AssistantFeedbackResponse = {
  entries: Array<{
    id: string;
    rating: "up" | "down";
    plan_id: number | null;
    excerpt_key: string;
    message_excerpt: string | null;
    created_at: string;
  }>;
};

export type AssistantStreamHandlers = {
  onToken: (text: string) => void;
  onDone: (data?: {
    final_content?: string;
    proposed_actions?: AssistantProposedAction[];
  }) => void;
  onError: (message: string) => void;
  onAction?: (action: AssistantProposedAction) => void;
  onMeta?: (meta: { tools_degraded?: boolean; note?: string }) => void;
};

export async function fetchAssistantStatus(): Promise<AssistantStatus> {
  return engineFetch<AssistantStatus>("/assistant/status");
}

export async function fetchAssistantHistory(): Promise<AssistantHistoryResponse> {
  return engineFetch<AssistantHistoryResponse>("/assistant/history");
}

export async function clearAssistantHistory(): Promise<{ ok: boolean }> {
  return engineFetch<{ ok: boolean }>("/assistant/history", { method: "DELETE" });
}

/** Clear Apply/Dismiss decision memory for one plan or the whole tenant. */
export async function clearAssistantDecisions(input: {
  planId?: number;
  all?: boolean;
}): Promise<{ ok: boolean; scope: "plan" | "tenant"; plan_id: number | null; deleted: number }> {
  const params = new URLSearchParams();
  if (input.all) params.set("all", "true");
  else if (input.planId != null) params.set("plan_id", String(input.planId));
  const q = params.toString();
  return engineFetch(`/assistant/decisions${q ? `?${q}` : ""}`, { method: "DELETE" });
}

/** Clear thumbs ratings (ranking only — not chat or decisions). */
export async function clearAssistantFeedback(): Promise<{ ok: boolean; deleted: number }> {
  return engineFetch<{ ok: boolean; deleted: number }>("/assistant/feedback", {
    method: "DELETE",
  });
}

export async function postAssistantFeedback(input: {
  rating: AssistantFeedbackRating;
  message_excerpt?: string;
  plan_id?: number;
  comment?: string;
}): Promise<{ ok: boolean; id: string }> {
  return engineFetch<{ ok: boolean; id: string }>("/assistant/feedback", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchAssistantFeedback(): Promise<AssistantFeedbackResponse> {
  return engineFetch("/assistant/feedback");
}

export async function applyAssistantAction(
  action: AssistantProposedAction,
): Promise<AssistantActionApplyResponse> {
  return engineFetch<AssistantActionApplyResponse>("/assistant/actions/apply", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

export async function dismissAssistantAction(
  action: AssistantProposedAction,
): Promise<{ ok: boolean; decision?: unknown }> {
  return engineFetch<{ ok: boolean; decision?: unknown }>("/assistant/actions/dismiss", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

export async function fetchPlanDecisions(planId: number): Promise<{ decisions: PlanDecision[] }> {
  return engineFetch(`/plans/${planId}/decisions`);
}

export async function postAssistantChat(input: {
  messages: AssistantChatMessage[];
  plan_id?: number;
  use_other_builds_as_examples?: boolean;
}): Promise<AssistantChatResponse> {
  return engineFetch<AssistantChatResponse>("/assistant/chat", {
    method: "POST",
    body: JSON.stringify({ ...input, stream: false }),
  });
}

/** Streams SSE from POST /assistant/chat (default stream mode). */
export async function streamAssistantChat(
  input: {
    messages: AssistantChatMessage[];
    plan_id?: number;
    use_other_builds_as_examples?: boolean;
  },
  handlers: AssistantStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await engineFetchStream({
      path: "/assistant/chat",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, stream: true }),
      signal,
      failureMessage: "Assistant chat failed",
    });
  } catch (error) {
    if (error instanceof EngineHttpError && error.status === 401) {
      handlers.onError("Authentication required");
    } else {
      handlers.onError(error instanceof Error ? error.message : "Assistant chat failed");
    }
    return;
  }
  if (!res.body) {
    handlers.onError("Empty assistant response");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const data = JSON.parse(payload) as {
          text?: string;
          detail?: string;
          ok?: boolean;
          action?: AssistantProposedAction;
          tools_degraded?: boolean;
          note?: string;
          final_content?: string;
          proposed_actions?: AssistantProposedAction[];
        };
        if (eventName === "token" && data.text) handlers.onToken(data.text);
        else if (eventName === "action" && data.action) handlers.onAction?.(data.action);
        else if (eventName === "meta") handlers.onMeta?.(data);
        else if (eventName === "error") handlers.onError(data.detail ?? "Assistant error");
        else if (eventName === "done") {
          handlers.onDone({
            final_content: data.final_content,
            proposed_actions: data.proposed_actions,
          });
        }
      } catch {
        /* ignore malformed chunk */
      }
      eventName = "message";
    }
  }
}
