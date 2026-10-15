const { appendFileSync } = require("node:fs");

const argument = process.argv.find((value) => value.startsWith("--pp-lifecycle-events="));
if (!argument) throw new Error("Lifecycle event path missing");
const events = argument.slice("--pp-lifecycle-events=".length);
function record(event, fields = {}) {
  appendFileSync(events, JSON.stringify({ event, pid: process.pid, ...fields }) + "\n");
}
record("start");

const emit = process.emit;
process.emit = function (event, ...args) {
  if (event === "SIGTERM" || event === "SIGINT") record(event);
  return Reflect.apply(emit, this, [event, ...args]);
};
const stdinEmit = process.stdin.emit;
process.stdin.emit = function (event, ...args) {
  if (event === "end") {
    record("stdin_end");
    if (process.argv.includes("--pp-lifecycle-suppress-eof")) {
      record("stdin_end_suppressed");
      return false;
    }
  }
  return Reflect.apply(stdinEmit, this, [event, ...args]);
};
const kill = process.kill;
process.kill = function (pid, signal) {
  if (signal !== 0) record("kill", { target: pid, signal });
  return Reflect.apply(kill, this, [pid, signal]);
};
