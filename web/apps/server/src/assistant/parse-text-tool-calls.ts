import { ASSISTANT_TOOL_SPECS } from "./tools.js";
import type { AssistantToolCallRequest } from "./types.js";

/** Keep in sync with ASSISTANT_TOOL_SPECS — local models often invent JSON/prose instead of tool_calls. */
const KNOWN_TOOLS = new Set(ASSISTANT_TOOL_SPECS.map((t) => t.name));

/**
 * Local models (e.g. llama3.1 via Ollama) often write fake tool-call JSON in
 * assistant text instead of returning structured tool_calls. Recover those.
 */
export function parseTextEmbeddedToolCalls(content: string): AssistantToolCallRequest[] {
  if (!content.trim()) return [];
  const found: AssistantToolCallRequest[] = [];
  const seen = new Set<string>();

  const push = (name: string, input: Record<string, unknown>) => {
    if (!KNOWN_TOOLS.has(name)) {
      return;
    }
    const key = `${name}:${JSON.stringify(input)}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      id: `text_call_${found.length + 1}`,
      name,
      input,
    });
  };

  const patterns = [
    // {"name":"get_source_docs","parameters":{...}}
    /\{\s*"name"\s*:\s*"([a-z0-9_]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/gi,
    // {"name":"get_source_docs","arguments":{...}} or "arguments":"{...}"
    /\{\s*"name"\s*:\s*"([a-z0-9_]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\}|"[^"]*")\s*\}/gi,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1]!;
      let rawArgs = m[2]!;
      if (rawArgs.startsWith('"')) {
        try {
          rawArgs = JSON.parse(rawArgs) as string;
        } catch {
          continue;
        }
      }
      let input: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(rawArgs) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        continue;
      }
      push(name, input);
    }
  }

  // Prose narration: "I will call the `get_build_recipe` function"
  const proseMentions = [
    ...content.matchAll(
      /(?:call(?:ing)?|invoke|use)\s+(?:the\s+)?[`"']?([a-z][a-z0-9_]*)[`"']?\s*(?:function|tool)?/gi,
    ),
  ].map((m) => m[1]!);
  for (const name of proseMentions) {
    if (KNOWN_TOOLS.has(name)) push(name, {});
  }

  return found;
}

/** Strip recovered fake tool JSON blobs and tool-call narration from the final answer. */
export function stripEmbeddedToolCallJson(content: string): string {
  let out = content;
  out = out.replace(
    /\{\s*"name"\s*:\s*"[a-z0-9_]+"\s*,\s*"(?:parameters|arguments)"\s*:\s*(?:\{[\s\S]*?\}|"[^"]*")\s*\}/gi,
    "",
  );
  out = out.replace(/```json\s*[\s\S]*?```/gi, (block) =>
    /"name"\s*:\s*"(?:get_|list_|apply_|set_|add_|remove_|update_|start_|propose_|ui_|create_|compare_)/.test(
      block,
    )
      ? ""
      : block,
  );
  out = out.replace(/run\s+`?call\s*\[["'][^"']+["']\]`?/gi, "");
  out = out.replace(/call\s*\[\s*["'][^"']+["']\s*\]/gi, "");
  // "I will call the `get_build_recipe` function to …"
  // Only strip when the mentioned name is a known tool — avoid wiping
  // prose like "I cannot use FakePrinterKit-9000".
  out = out.replace(
    /[^.!?\n]*(?:I will |I'll |Let me |To answer[^,.]*[, ]+I (?:will|shall) )?(?:call(?:ing)?|invoke|use)\s+(?:the\s+)?[`"']?([a-z][a-z0-9_]*)[`"']?\s*(?:function|tool)?[^.!?\n]*[.!?]?\s*/gi,
    (full, name) => (KNOWN_TOOLS.has(String(name).toLowerCase()) ? "" : full),
  );
  // "Here is a possible response:" empty scaffolding
  out = out.replace(/\bHere is a possible response:\s*/gi, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
