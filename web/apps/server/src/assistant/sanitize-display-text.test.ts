import { describe, expect, it } from "vitest";
import { sanitizeAssistantDisplayText } from "./sanitize-display-text.js";

describe("sanitizeAssistantDisplayText", () => {
  it("strips click-Apply scaffolding and orphan braces", () => {
    const raw = `Plan ready.

Here is an example of what the build recipe might look like:
\`\`\`json
{"plan_id":1,"base":{"source_name":"Voron-Trident"}}
\`\`\`
To apply these settings, click on the "Apply" button in the UI.
Please confirm to proceed with setting up the plan.
}}`;
    const cleaned = sanitizeAssistantDisplayText(raw);
    expect(cleaned).toContain("Plan ready");
    expect(cleaned).not.toMatch(/click/i);
    expect(cleaned).not.toContain("}}");
    expect(cleaned).not.toContain("plan_id");
  });
});
