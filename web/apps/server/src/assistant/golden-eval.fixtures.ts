/**
 * Golden eval fixtures for kit-advisor tool / action behavior.
 * These encode expected Q→tool outcomes without calling a live LLM.
 */
export type GoldenEvalCase = {
  id: string;
  description: string;
  /** Natural-language question (documentation / future LLM eval harness). */
  question: string;
  /**
   * Tool the advisor should invoke (or the behavior under test).
   * `null` means assert via apply path / negative case only.
   */
  expected_tool: string | null;
  tool_input?: Record<string, unknown>;
  /** Assert on invokeAssistantTool result. */
  expect: {
    proposes_action?: boolean;
    action_type?: string;
    content_includes?: string[];
    content_excludes?: string[];
    /** When true, content JSON should have an error field. */
    error?: boolean;
  };
};

export const GOLDEN_EVAL_FIXTURES: GoldenEvalCase[] = [
  {
    id: "recommend-known-stack-preset",
    description: "Recommend a catalog stack preset by proposing apply_stack_preset",
    question: "Set up my plan like Voron 2.4 stock with Stealthburner and Tap",
    expected_tool: "apply_stack_preset",
    tool_input: { preset_id: "voron_2.4_stock_sb_tap" },
    expect: {
      proposes_action: true,
      action_type: "apply_stack_preset",
      content_includes: ["proposed", "voron_2.4_stock_sb_tap"],
    },
  },
  {
    id: "respect-use-other-builds-off",
    description: "list_example_builds must honor use_other_builds_as_examples=false",
    question: "What have I done on other builds?",
    expected_tool: "list_example_builds",
    tool_input: {},
    expect: {
      proposes_action: false,
      content_includes: ["disabled"],
    },
  },
  {
    id: "do-not-invent-unknown-source",
    description: "set_base must not invent a source that is not synced in the tenant",
    question: "Use FakePrinterKit-9000 as my base",
    expected_tool: "set_base",
    tool_input: { source_name: "FakePrinterKit-9000" },
    expect: {
      proposes_action: false,
      error: true,
      content_includes: ["not found", "do not invent"],
    },
  },
  {
    id: "refuse-unsynced-source",
    description: "set_base refuses a known but unsynced source",
    question: "Set base to UnsyncedKit before I sync it",
    expected_tool: "set_base",
    tool_input: { source_name: "UnsyncedKit" },
    expect: {
      proposes_action: false,
      error: true,
      content_includes: ["not synced"],
    },
  },
  {
    id: "propose-set-base-synced",
    description: "set_base proposes when the source exists and is synced",
    question: "Switch my base to SyncedKit",
    expected_tool: "set_base",
    tool_input: { source_name: "SyncedKit" },
    expect: {
      proposes_action: true,
      action_type: "set_base",
      content_includes: ["proposed"],
    },
  },
  {
    id: "catalog-lists-stack-presets",
    description: "get_kit_catalog exposes known stack presets for recommendations",
    question: "What stack presets are available?",
    expected_tool: "get_kit_catalog",
    tool_input: {},
    expect: {
      proposes_action: false,
      content_includes: ["Stack presets", "voron_2.4_stock_sb_tap"],
    },
  },
];
