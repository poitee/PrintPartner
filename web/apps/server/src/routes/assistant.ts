import type { FastifyInstance } from "fastify";
import type {
  AssistantActionApplyRequest,
  AssistantFeedbackRequest,
  AssistantProposedAction,
  AssistantStatus,
} from "@print-partner/contracts";
import { isAssistantUiAction } from "@print-partner/contracts";
import type { ServerConfig } from "../config.js";
import type { AppRepository } from "../db/repository.js";
import type { InProcessJobRunner } from "./jobs.js";
import { createAssistantPort } from "../assistant/create-assistant.js";
import { resolveAssistantRuntime } from "../assistant/resolve-assistant.js";
import { applyAssistantAction } from "../assistant/tools.js";
import { getSearchStatus, searchOverridesFromRuntime } from "../services/search/index.js";
import { buildPreferencesDigest } from "../assistant/preferences-digest.js";
import {
  appendAssistantFeedback,
  appendPendingProposedActions,
  buildThumbsPreferDigestLine,
  clearAssistantFeedback,
  clearAssistantHistory,
  collectCatalogFeedbackTokens,
  feedbackExcerptKey,
  loadAssistantFeedback,
  loadAssistantHistory,
  removePendingProposedAction,
} from "../assistant/history.js";
import { loadKitCatalog } from "../services/kit-catalog.js";
import { loadDailyUsage } from "../assistant/usage.js";
import {
  importAssistantDomainPack,
  loadAssistantDomainPack,
  type DomainImportPayload,
} from "../assistant/domain-pack.js";
import { sendProblem } from "../lib/api-error.js";

type RouteDeps = {
  repo: AppRepository;
  config: ServerConfig;
  jobs: InProcessJobRunner;
};

/** Apply/dismiss + decision/feedback data. In-app chat is gone (GRE-225); use HTTP MCP. */
export async function registerAssistantRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get("/assistant/status", async (): Promise<AssistantStatus> => {
    const runtime = resolveAssistantRuntime(deps.repo, deps.config);
    const assistant = createAssistantPort(runtime);
    const usage = loadDailyUsage(deps.repo);
    const search = getSearchStatus(
      deps.config,
      searchOverridesFromRuntime(runtime),
    );
    return {
      enabled: false,
      provider: assistant.provider,
      model: assistant.model,
      use_other_builds_as_examples: runtime.useOtherBuildsAsExamples,
      tools_supported: assistant.supportsTools,
      source: runtime.source,
      daily_request_budget: runtime.aiDailyRequestBudget || null,
      daily_token_budget: runtime.aiDailyTokenBudget || null,
      daily_requests_used: usage.requests,
      daily_tokens_used: usage.tokens,
      search,
    };
  });

  app.get("/assistant/history", async () => {
    return { messages: loadAssistantHistory(deps.repo) };
  });

  app.delete("/assistant/history", async () => {
    clearAssistantHistory(deps.repo);
    return { ok: true };
  });

  /** Preferences digest from plan_decisions / feedback (self-host only). */
  app.get("/assistant/preferences", async (request, reply) => {
    if (deps.config.deployMode !== "self-host") {
      return sendProblem(
        reply,
        404,
        "Not Found",
        "Preferences debug endpoint is available in self-host mode only",
      );
    }
    const q = request.query as { plan_id?: string };
    const raw = q.plan_id != null ? Number(q.plan_id) : NaN;
    const planId = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
    if (planId != null && !deps.repo.getOwnedProfileIdentity(planId)) {
      return sendProblem(reply, 404, "Not Found", "Plan not found");
    }
    const digest = buildPreferencesDigest(deps.repo, planId);
    const catalogTokens = collectCatalogFeedbackTokens(loadKitCatalog());
    const thumbs_prefer = buildThumbsPreferDigestLine(deps.repo, catalogTokens);
    return {
      plan_id: planId,
      digest,
      thumbs_prefer,
    };
  });

  /**
   * Clear Apply/Dismiss/note decision memory.
   * Requires either `plan_id` (one plan) or `all=true` (entire tenant) — never ambiguous.
   */
  app.delete("/assistant/decisions", async (request, reply) => {
    const q = request.query as { plan_id?: string; all?: string };
    const all =
      q.all === "true" || q.all === "1" || String(q.all ?? "").toLowerCase() === "yes";
    const raw = q.plan_id != null ? Number(q.plan_id) : NaN;
    const planId = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;

    if (all && planId != null) {
      return sendProblem(
        reply,
        400,
        "Bad Request",
        "Pass either plan_id or all=true, not both",
      );
    }
    if (!all && planId == null) {
      return sendProblem(
        reply,
        400,
        "Bad Request",
        "Specify plan_id=<id> to clear one plan, or all=true to clear all decision memory for this tenant",
      );
    }

    if (planId != null) {
      if (!deps.repo.getOwnedProfileIdentity(planId)) {
        return sendProblem(reply, 404, "Not Found", "Plan not found");
      }
      const deleted = deps.repo.deletePlanDecisionsForPlan(planId);
      return { ok: true, scope: "plan" as const, plan_id: planId, deleted };
    }

    const deleted = deps.repo.deleteAllPlanDecisions();
    return { ok: true, scope: "tenant" as const, plan_id: null, deleted };
  });

  app.get("/assistant/feedback", async () => {
    const entries = loadAssistantFeedback(deps.repo).map((e) => ({
      id: e.id,
      rating: e.rating,
      plan_id: e.plan_id,
      excerpt_key: feedbackExcerptKey(e.message_excerpt),
      message_excerpt: e.message_excerpt?.slice(0, 400) ?? null,
      created_at: e.created_at,
    }));
    return { entries };
  });

  app.delete("/assistant/feedback", async () => {
    const deleted = clearAssistantFeedback(deps.repo);
    return { ok: true, deleted };
  });

  app.post(
    "/assistant/feedback",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as AssistantFeedbackRequest;
      if (body.rating !== "up" && body.rating !== "down") {
        return sendProblem(reply, 400, "Bad Request", "rating must be up or down");
      }
      const entry = appendAssistantFeedback(deps.repo, {
        rating: body.rating,
        message_excerpt: body.message_excerpt,
        plan_id: typeof body.plan_id === "number" ? body.plan_id : undefined,
        comment: typeof body.comment === "string" ? body.comment.slice(0, 200) : undefined,
      });
      return { ok: true, id: entry.id };
    },
  );

  app.post(
    "/assistant/actions/apply",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as AssistantActionApplyRequest;
      const action = body.action as AssistantProposedAction | undefined;
      if (!action || typeof action !== "object" || typeof action.type !== "string") {
        return sendProblem(reply, 400, "Bad Request", "action is required");
      }
      if (typeof action.plan_id !== "number" || !Number.isFinite(action.plan_id)) {
        return sendProblem(reply, 400, "Bad Request", "action.plan_id is required");
      }
      let result: Awaited<ReturnType<typeof applyAssistantAction>>;
      try {
        result = await applyAssistantAction(action, {
          repo: deps.repo,
          jobs: deps.jobs,
          tenantId: request.tenantId,
        });
      } catch {
        request.log.error(
          { failure: "unexpected", actionType: action.type, planId: action.plan_id },
          "Assistant action apply failed",
        );
        return sendProblem(reply, 500, "Internal Server Error", "Internal Server Error");
      }
      if (!result.ok) {
        const status = result.status === 500 || result.status === 503 ? result.status : 400;
        if (status === 500) {
          request.log.error(
            {
              failure: result.detail === "Accepted Plan data is inconsistent"
                ? "integrity"
                : "unexpected",
              actionType: action.type,
              planId: action.plan_id,
            },
            "Assistant action apply failed",
          );
        }
        return sendProblem(
          reply,
          status,
          status === 503
            ? "Service Unavailable"
            : status === 500
              ? "Internal Server Error"
              : "Bad Request",
          result.detail ?? "Action failed",
        );
      }
      removePendingProposedAction(deps.repo, action.id);
      const followUp =
        result.result &&
        typeof result.result === "object" &&
        (result.result as { follow_up_action?: AssistantProposedAction }).follow_up_action;
      if (
        followUp &&
        typeof followUp === "object" &&
        typeof followUp.type === "string" &&
        !isAssistantUiAction(followUp.type)
      ) {
        appendPendingProposedActions(deps.repo, [followUp]);
      }
      return result;
    },
  );

  app.post(
    "/assistant/actions/dismiss",
    { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { action?: AssistantProposedAction };
      const action = body.action;
      if (!action || typeof action !== "object" || typeof action.type !== "string") {
        return sendProblem(reply, 400, "Bad Request", "action is required");
      }
      if (typeof action.plan_id !== "number" || !Number.isFinite(action.plan_id)) {
        return sendProblem(reply, 400, "Bad Request", "action.plan_id is required");
      }
      const { logDismissedAction } = await import("../services/plan-decisions.js");
      const entry = logDismissedAction(deps.repo, action);
      removePendingProposedAction(deps.repo, action.id);
      return { ok: true, decision: entry };
    },
  );

  app.post(
    "/assistant/chat",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      return sendProblem(
        reply,
        410,
        "Gone",
        "In-app kit advisor chat is removed. Attach Cursor / Grok / Claude via HTTP MCP at /api/v1/mcp (PRINT_PARTNER_API_KEY). See docs/assistant-mcp.md.",
      );
    },
  );

  app.get("/assistant/domain", async () => {
    const pack = loadAssistantDomainPack({ dataDir: deps.config.dataDir });
    return {
      loaded: Boolean(pack),
      chars: pack.length,
      preview: pack.slice(0, 500),
    };
  });

  app.post(
    "/assistant/domain/import",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as DomainImportPayload;
      if (!body || typeof body !== "object") {
        return sendProblem(reply, 400, "Bad Request", "JSON body required");
      }
      try {
        const result = importAssistantDomainPack(body, {
          dataDir: deps.config.dataDir,
          repo: deps.repo,
        });
        return result;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return sendProblem(reply, 400, "Bad Request", detail);
      }
    },
  );
}
