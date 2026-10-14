import assert from "node:assert/strict";
import { canonical, digest, type Json } from "./model.mjs";

type Selection =
  | { kind: "disabled" }
  | { kind: "ts" }
  | { kind: "missing-rust"; engine: "rust" | "both" };

type Receipt = { format: "gre487-replay-v1" } & (
  | { kind: "disabled"; typescript: "not-run"; rust: "not-run" }
  | { kind: "unavailable"; engine: "rust" | "both"; typescript: "not-run"; rust: "not-run" }
  | { kind: "ts-pass"; rust: "not-run"; runs: [Json, Json]; evidenceSha256: [string, string] }
  | { kind: "fail"; error: string }
);

const arguments_ = process.argv.slice(2);
const jsonOutput = arguments_.includes("--format=json");

function selection(): Selection {
  let enabled = process.env.GRE487_DELAYED_PATCH === "1";
  let engine: "ts" | "rust" | "both" = "both";
  const seen = new Set<string>();
  for (const argument of arguments_) {
    const key = argument.split("=")[0];
    if (seen.has(key)) throw new Error(`Repeated argument ${key}`);
    seen.add(key);
    switch (argument) {
      case "--enabled": enabled = true; break;
      case "--engine=ts": engine = "ts"; break;
      case "--engine=rust": engine = "rust"; break;
      case "--engine=both": engine = "both"; break;
      case "--format=json": break;
      default: throw new Error(`Unknown argument ${argument}`);
    }
  }
  if (!enabled) return { kind: "disabled" };
  return engine === "ts" ? { kind: "ts" } : { kind: "missing-rust", engine };
}

async function verifyGre487(): Promise<Receipt> {
  const selected = selection();
  const format = "gre487-replay-v1";
  switch (selected.kind) {
    case "disabled":
      return { format, kind: "disabled", typescript: "not-run", rust: "not-run" };
    case "missing-rust":
      return { format, kind: "unavailable", engine: selected.engine, typescript: "not-run", rust: "not-run" };
    case "ts": {
      const { replayGre487 } = await import("./gre487-scenario.mjs");
      const first = await replayGre487();
      const second = await replayGre487();
      const firstCanonical = canonical(first);
      const secondCanonical = canonical(second);
      assert.equal(secondCanonical, firstCanonical, "Independent TypeScript replays differ");
      return {
        format, kind: "ts-pass", rust: "not-run", runs: [first, second],
        evidenceSha256: [digest(firstCanonical), digest(secondCanonical)],
      };
    }
  }
}

function report(receipt: Receipt): number {
  if (jsonOutput) process.stdout.write(`${JSON.stringify(receipt)}\n`);
  switch (receipt.kind) {
    case "disabled":
      if (!jsonOutput) process.stdout.write("DISABLED; enable GRE487_DELAYED_PATCH=1 or --enabled and choose --engine=ts\n");
      return 0;
    case "unavailable":
      process.stderr.write(`UNAVAILABLE; --engine=${receipt.engine} requires the missing live Rust pp-services draft/save replay. Rust NOT RUN; TypeScript NOT RUN\n`);
      return 2;
    case "ts-pass":
      if (!jsonOutput) process.stdout.write("TS PASS; Rust NOT RUN; two independent replays, three fresh edits, held D0 PATCH refused with 409 draft_changed and exact DB/file no-write, draft reopen, POST save, accepted Review reopen\n");
      return 0;
    case "fail":
      process.stderr.write(`FAIL; ${receipt.error}\n`);
      return 1;
  }
}

let receipt: Receipt;
try {
  receipt = await verifyGre487();
} catch (error) {
  receipt = {
    format: "gre487-replay-v1", kind: "fail",
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
}
process.exitCode = report(receipt);
