import assert from "node:assert/strict";
import { canonical } from "./model.mjs";

type Selection =
  | { kind: "disabled" }
  | { kind: "ts" }
  | { kind: "missing-rust"; engine: "rust" | "both" };

function selection(): Selection {
  let enabled = process.env.GRE487_DELAYED_PATCH === "1";
  let engine: "ts" | "rust" | "both" = "both";
  const seen = new Set<string>();
  for (const argument of process.argv.slice(2)) {
    const key = argument.split("=")[0];
    if (seen.has(key)) throw new Error(`Repeated argument ${key}`);
    seen.add(key);
    switch (argument) {
      case "--enabled": enabled = true; break;
      case "--engine=ts": engine = "ts"; break;
      case "--engine=rust": engine = "rust"; break;
      case "--engine=both": engine = "both"; break;
      default: throw new Error(`Unknown argument ${argument}`);
    }
  }
  if (!enabled) return { kind: "disabled" };
  return engine === "ts" ? { kind: "ts" } : { kind: "missing-rust", engine };
}

async function verifyGre487(): Promise<number> {
  const selected = selection();
  switch (selected.kind) {
    case "disabled":
      process.stdout.write("DISABLED; enable GRE487_DELAYED_PATCH=1 or --enabled and choose --engine=ts\n");
      return 0;
    case "missing-rust":
      process.stderr.write(`UNAVAILABLE; --engine=${selected.engine} requires the missing live Rust pp-services draft/save replay. Rust NOT RUN; TypeScript NOT RUN\n`);
      return 2;
    case "ts": {
      const { replayGre487 } = await import("./gre487-scenario.mjs");
      const first = await replayGre487();
      const second = await replayGre487();
      assert.equal(canonical(second), canonical(first), "Independent TypeScript replays differ");
      process.stdout.write("TS PASS; Rust NOT RUN; two independent replays, three fresh edits, held D0 PATCH refused with 409 draft_changed and exact DB/file no-write, draft reopen, POST save, accepted Review reopen\n");
      return 0;
    }
  }
}

try {
  process.exitCode = await verifyGre487();
} catch (error) {
  process.stderr.write(`FAIL; ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
