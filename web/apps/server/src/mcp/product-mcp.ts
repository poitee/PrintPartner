/**
 * Shared product MCP handlers (stdio + streamable HTTP).
 * Mutating tools only propose; confirm_apply / dismiss_proposed_action apply.
 *
 * Callers pass a pending map scoped to one MCP process (stdio) or one HTTP
 * MCP session — never a shared cross-client map.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AssistantProposedAction } from "@print-partner/contracts";
import { isAssistantUiAction } from "@print-partner/contracts";
import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { createAssistantPort } from "../assistant/create-assistant.js";
import { resolveAssistantRuntime } from "../assistant/resolve-assistant.js";
import {
  ASSISTANT_TOOL_SPECS,
  applyAssistantAction,
  invokeAssistantTool,
  type ToolContext,
} from "../assistant/tools.js";
import type { InProcessJobRunner } from "../routes/jobs.js";
import type { AppRepository } from "../db/repository.js";
import { createIntegrationPort, type IntegrationPort } from "../integrations/store.js";
import { getIntegrationAdapter } from "../integrations/registry.js";

export const META_TOOLS = [
  {
    name: "list_pending_actions",
    description:
      "List proposed mutations waiting for confirm_apply in this MCP session (same confirm-to-apply semantics as Apply cards).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "confirm_apply",
    description:
      "Apply a previously proposed action after user confirmation. Optional suggested_excludes overrides the card params (same merge as SPA).",
    inputSchema: {
      type: "object" as const,
      properties: {
        action_id: { type: "string", description: "Id from a prior propose tool result" },
        suggested_excludes: {
          type: "array",
          items: { type: "string" },
          description: "Optional override of kit-manifest exclude tags to merge on Apply",
        },
      },
      required: ["action_id"],
    },
  },
  {
    name: "dismiss_proposed_action",
    description: "Discard a pending proposed action without applying it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action_id: { type: "string" },
      },
      required: ["action_id"],
    },
  },
] as const;

/** Product verbs exposed over MCP (skip SPA-only ui_* tools). */
export function productToolSpecs() {
  return ASSISTANT_TOOL_SPECS.filter((t) => !t.name.startsWith("ui_"));
}

export function jsonSchemaToMcp(spec: (typeof ASSISTANT_TOOL_SPECS)[number]) {
  return {
    name: spec.name,
    description:
      spec.tier === "mutate"
        ? `${spec.description} (proposes only — call confirm_apply to mutate)`
        : spec.description,
    inputSchema: {
      type: "object" as const,
      properties: spec.input_schema.properties ?? {},
      ...(spec.input_schema.required?.length
        ? { required: spec.input_schema.required }
        : {}),
    },
  };
}

export type ProductMcpDeps = {
  getRepo: () => AppRepository;
  jobs: InProcessJobRunner;
  config: ServerConfig;
  /** Optional default plan when tool args omit plan_id. */
  defaultPlanId?: number | null;
  /**
   * Pending proposes for this MCP session / stdio process only.
   * HTTP mounts one map per streamable-HTTP session.
   */
  pending: Map<string, AssistantProposedAction>;
  /** Optional tenant for jobs started via confirm_apply. */
  tenantId?: string;
  /**
   * Live printer-host access for farm tools (get_farm_status). Optional so
   * tests can inject a stub; when omitted a real port is built from the repo,
   * because without one get_farm_status reports every printer as "unknown".
   */
  integrations?: IntegrationPort;
};

export function createProductMcpServer(deps: ProductMcpDeps): Server {
  const { getRepo, jobs, config, pending } = deps;
  const defaultPlanId = deps.defaultPlanId ?? null;
  const tenantId = deps.tenantId;

  // get_farm_status needs an IntegrationPort to read live printer state. It is
  // built lazily and cached: constructing it per tool call would re-resolve
  // adapters on every request, and building it eagerly would run before the
  // repo is necessarily connected.
  let integrationsPort: IntegrationPort | undefined = deps.integrations;
  function getIntegrations(): IntegrationPort {
    if (!integrationsPort) {
      integrationsPort = createIntegrationPort({
        repo: getRepo(),
        getAdapter: getIntegrationAdapter,
      });
    }
    return integrationsPort;
  }

  function toolCtx(): ToolContext {
    const repo = getRepo();
    const runtime = resolveAssistantRuntime(repo, config);
    return {
      repo,
      activePlanId: defaultPlanId,
      useOtherBuildsAsExamples: runtime.useOtherBuildsAsExamples,
      dataDir: config.dataDir,
      thumbsDir: join(config.dataDir, "thumbs"),
      assistant: createAssistantPort(runtime),
      runtime,
      integrations: getIntegrations(),
    };
  }

  const server = new Server(
    { name: "print-partner-assistant", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...productToolSpecs().map(jsonSchemaToMcp),
      ...META_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args =
      request.params.arguments && typeof request.params.arguments === "object"
        ? (request.params.arguments as Record<string, unknown>)
        : {};

    try {
      if (name === "list_pending_actions") {
        const actions = [...pending.values()].map((a) => ({
          id: a.id,
          type: a.type,
          plan_id: a.plan_id,
          label: a.label,
          summary: a.summary,
          params: a.params,
        }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ actions }, null, 2) }],
        };
      }

      if (name === "dismiss_proposed_action") {
        const id = String(args.action_id ?? "");
        const existed = pending.delete(id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: existed, action_id: id }),
            },
          ],
        };
      }

      if (name === "confirm_apply") {
        const id = String(args.action_id ?? "");
        // Reserve before any await so concurrent confirms cannot double-apply.
        const action = pending.get(id);
        if (!action || !pending.delete(id)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: "Unknown, in-flight, or already applied/dismissed action_id",
                  action_id: id,
                }),
              },
            ],
            isError: true,
          };
        }
        if (isAssistantUiAction(action.type)) {
          pending.set(id, action);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: false, error: "UI actions cannot be applied via MCP" }),
              },
            ],
            isError: true,
          };
        }
        const toApply: AssistantProposedAction =
          Array.isArray(args.suggested_excludes)
            ? {
                ...action,
                params: {
                  ...action.params,
                  suggested_excludes: args.suggested_excludes
                    .map((x) => String(x).trim())
                    .filter(Boolean),
                },
              }
            : action;
        try {
          const result = await applyAssistantAction(toApply, {
            repo: getRepo(),
            jobs,
            tenantId,
          });
          if (!result.ok) {
            // Restore so the client can retry or dismiss.
            pending.set(id, action);
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            ...(result.ok ? {} : { isError: true }),
          };
        } catch (applyErr) {
          pending.set(id, action);
          throw applyErr;
        }
      }

      const known = productToolSpecs().some((t) => t.name === name);
      if (!known) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
          isError: true,
        };
      }

      const result = await invokeAssistantTool(name, args, toolCtx());
      if (result.proposedAction && !isAssistantUiAction(result.proposedAction.type)) {
        pending.set(result.proposedAction.id, result.proposedAction);
      }
      return {
        content: [{ type: "text" as const, text: result.content }],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}
