import { appendFileSync as startupAppend, readFileSync as startupRead, realpathSync as startupRealpath } from "node:fs";
import { createHash as startupHash } from "node:crypto";
import { resolve as startupResolve } from "node:path";

const startupEvents = startupResolve("startup-events.jsonl");
const startupRecord = (event, fields = {}) => startupAppend(startupEvents,
  JSON.stringify({ event, pid: process.pid, ...fields }) + "\n");
const startupEmit = process.stdin.emit;
process.stdin.emit = function (event, ...args) {
  if (event === "end") startupRecord("stdin_end");
  return Reflect.apply(startupEmit, this, [event, ...args]);
};
const startupOn = process.stdin.on;
process.stdin.on = function (event, listener) {
  const result = Reflect.apply(startupOn, this, [event, listener]);
  if (event === "data") {
    const stack = new Error("built desktop setup reader registered").stack;
    const entry = startupRealpath(process.argv[1]);
    if (!stack.includes("setupFromParent") || !stack.includes(entry)) {
      throw new Error("Unexpected desktop setup reader");
    }
    startupRecord("setup_reader_registered", {
      entry, entry_sha256: startupHash("sha256").update(startupRead(entry)).digest("hex"),
      stack, listener_registered: this.listeners("data").includes(listener),
      stdin_readable_length: this.readableLength,
    });
    process.kill(process.pid, "SIGSTOP");
  }
  return result;
};
