/**
 * Clean model scaffolding / leftover JSON fragments from assistant chat text
 * for history storage and UI display.
 */
export function sanitizeAssistantDisplayText(content: string): string {
  let out = content;
  // Fenced fake recipe dumps
  out = out.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, "");
  // Orphan closing braces / truncated tool JSON crumbs
  out = out.replace(/^\s*[}\]]+\s*$/gm, "");
  out = out.replace(/\n\s*[}\]]{1,4}\s*$/g, "");
  // “Click Apply” narration when cards already exist / are recovered
  out = out.replace(
    /\bTo apply these settings, click[\s\S]*?(?:proceed|build|UI)\.?\s*/gi,
    "",
  );
  out = out.replace(/\bPlease confirm to proceed[\s\S]*?(?:\n|$)/gi, "");
  out = out.replace(
    /\bHere is an example of what the build recipe[\s\S]*?(?=\n\n|$)/gi,
    "",
  );
  out = out.replace(/\bPlease note that this is just an example[\s\S]*?(?=\n\n|$)/gi, "");
  out = out.replace(/\n\n↗ [^\n]+/g, "");
  // Collapse excessive blank lines
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
