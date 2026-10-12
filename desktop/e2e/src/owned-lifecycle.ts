import { ChildProcess } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

export type ProcessRole = "launcher" | "descendant" | "display" | "worker";

export type SignalResult = "sent" | "refused";

type JournalRow =
  | {
      kind: "acquired";
      role: ProcessRole;
      pid: number;
      startIdentity: string;
      command: string;
    }
  | {
      kind: "signal-requested";
      role: ProcessRole;
      pid: number;
      signal: NodeJS.Signals;
      startIdentity: string;
    }
  | {
      kind: "signal-refused";
      pid: number;
      signal: NodeJS.Signals;
      startIdentity: string | null;
      reason: string;
    }
  | {
      kind: "signal-sent";
      role: ProcessRole;
      pid: number;
      signal: NodeJS.Signals;
      startIdentity: string;
    }
  | {
      kind: "child-exit";
      role: ProcessRole;
      pid: number;
      startIdentity: string;
      code: number | null;
      signal: NodeJS.Signals | null;
    };

type Acquired = {
  role: ProcessRole;
  pid: number;
  startIdentity: string;
};

let installed = false;

function journalPath(): string {
  const path = process.env.GRE492_JOURNAL;
  if (!path) {
    throw new Error("GRE492_JOURNAL is required");
  }
  return path;
}

function append(row: JournalRow): void {
  const fd = openSync(journalPath(), "a");
  try {
    writeSync(fd, `${JSON.stringify(row)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRole(value: unknown): value is ProcessRole {
  return (
    value === "launcher" ||
    value === "descendant" ||
    value === "display" ||
    value === "worker"
  );
}

function isSignal(value: unknown): value is NodeJS.Signals {
  return value === "SIGTERM" || value === "SIGKILL" || value === "SIGINT" || value === "SIGHUP";
}

function parseRow(value: unknown): JournalRow {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("lifecycle journal has an invalid row");
  }
  if (value.kind === "signal-refused") {
    if (typeof value.pid !== "number" || !isSignal(value.signal) || typeof value.reason !== "string") {
      throw new Error("lifecycle journal has an invalid refusal");
    }
    const startIdentity = value.startIdentity;
    if (startIdentity !== null && typeof startIdentity !== "string") {
      throw new Error("lifecycle journal has an invalid refusal");
    }
    return {
      kind: "signal-refused",
      pid: value.pid,
      signal: value.signal,
      startIdentity,
      reason: value.reason,
    };
  }
  if (typeof value.pid !== "number" || !isRole(value.role) || typeof value.startIdentity !== "string") {
    throw new Error("lifecycle journal has an invalid row");
  }
  if (value.kind === "acquired" && typeof value.command === "string") {
    return {
      kind: "acquired",
      role: value.role,
      pid: value.pid,
      startIdentity: value.startIdentity,
      command: value.command,
    };
  }
  if (
    (value.kind === "signal-requested" || value.kind === "signal-sent") &&
    isSignal(value.signal)
  ) {
    return value.kind === "signal-requested"
      ? {
          kind: "signal-requested",
          role: value.role,
          pid: value.pid,
          signal: value.signal,
          startIdentity: value.startIdentity,
        }
      : {
          kind: "signal-sent",
          role: value.role,
          pid: value.pid,
          signal: value.signal,
          startIdentity: value.startIdentity,
        };
  }
  if (value.kind === "child-exit") {
    const code = value.code;
    const exitSignal = value.signal;
    if (code !== null && typeof code !== "number") {
      throw new Error("lifecycle journal has an invalid exit");
    }
    if (exitSignal !== null && !isSignal(exitSignal)) {
      throw new Error("lifecycle journal has an invalid exit");
    }
    return {
      kind: "child-exit",
      role: value.role,
      pid: value.pid,
      startIdentity: value.startIdentity,
      code,
      signal: exitSignal,
    };
  }
  throw new Error("lifecycle journal has an invalid row");
}

function readJournal(): JournalRow[] {
  let text = "";
  try {
    text = readFileSync(journalPath(), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      return parseRow(parsed);
    });
}

export function readStartIdentity(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const start = stat.slice(close + 2).split(" ")[19];
  if (!start || !/^\d+$/.test(start)) {
    return null;
  }
  return start;
}

function acquiredMatch(pid: number, startIdentity: string): Acquired | null {
  let match: Acquired | null = null;
  for (const row of readJournal()) {
    if (row.kind === "acquired" && row.pid === pid && row.startIdentity === startIdentity) {
      match = { role: row.role, pid: row.pid, startIdentity: row.startIdentity };
    }
  }
  return match;
}

function commandOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`)
      .toString()
      .replaceAll("\0", " ")
      .replace(/token=[^\s]+/g, "token=redacted")
      .slice(0, 240);
  } catch {
    return "";
  }
}

function roleForCommand(file: string): ProcessRole {
  if (file === process.env.GRE492_APP_BINARY || file.endsWith("/pp-desktop")) {
    return "launcher";
  }
  if (file === "Xvfb" || file.endsWith("/Xvfb")) {
    return "display";
  }
  return "worker";
}

function acquire(input: {
  role: ProcessRole;
  pid: number;
  startIdentity: string;
  command: string;
}): void {
  if (acquiredMatch(input.pid, input.startIdentity)) {
    return;
  }
  append({ kind: "acquired", ...input });
}

function normalizeSignal(signal: NodeJS.Signals | number | undefined): NodeJS.Signals {
  if (signal === undefined || signal === 15 || signal === "SIGTERM") {
    return "SIGTERM";
  }
  if (signal === 9 || signal === "SIGKILL") {
    return "SIGKILL";
  }
  if (signal === 2 || signal === "SIGINT") {
    return "SIGINT";
  }
  if (signal === 1 || signal === "SIGHUP") {
    return "SIGHUP";
  }
  return "SIGTERM";
}

function isChild(value: unknown): value is ChildProcess {
  return value instanceof ChildProcess;
}

function wrapChildFactory(target: object, name: "spawn" | "fork"): void {
  const current: unknown = Reflect.get(target, name);
  if (typeof current !== "function") {
    if (name === "spawn") {
      throw new Error("child_process.spawn is unavailable");
    }
    return;
  }
  const wrapped = (...args: readonly unknown[]): ChildProcess => {
    const child: unknown = Reflect.apply(current, target, args);
    if (!isChild(child)) {
      throw new Error(`child_process.${name} did not return a child`);
    }
    return watch(child);
  };
  if (!Reflect.set(target, name, wrapped)) {
    throw new Error(`child_process.${name} cannot be wrapped`);
  }
  syncBuiltinESMExports();
}

const observedChildren = new WeakSet<ChildProcess>();

function observeChild(child: ChildProcess): void {
  if (observedChildren.has(child)) {
    return;
  }
  const pid = child.pid;
  if (!pid) {
    return;
  }
  observedChildren.add(child);
  const startIdentity = readStartIdentity(pid);
  if (!startIdentity) {
    return;
  }
  const role = roleForCommand(child.spawnfile);
  const command = child.spawnargs.join(" ").replace(/token=[^\s]+/g, "token=redacted").slice(0, 240);
  acquire({ role, pid, startIdentity, command });
  child.once("exit", (code, exitSignal) => {
    append({
      kind: "child-exit",
      role,
      pid,
      startIdentity,
      code,
      signal: isSignal(exitSignal) ? exitSignal : null,
    });
  });
}

export function requestSignal(pid: number, signal: NodeJS.Signals): SignalResult {
  const startIdentity = readStartIdentity(pid);
  const owned = startIdentity ? acquiredMatch(pid, startIdentity) : null;
  if (!owned || !startIdentity) {
    append({
      kind: "signal-refused",
      pid,
      signal,
      startIdentity,
      reason: startIdentity ? "not-acquired" : "process-absent",
    });
    return "refused";
  }
  append({
    kind: "signal-requested",
    role: owned.role,
    pid,
    signal,
    startIdentity,
  });
  process.kill(pid, signal);
  append({
    kind: "signal-sent",
    role: owned.role,
    pid,
    signal,
    startIdentity,
  });
  return "sent";
}

export function installOwnedLifecycle(): void {
  if (installed) {
    return;
  }
  installed = true;
  const originalKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function killOwned(
    this: ChildProcess,
    signal?: NodeJS.Signals | number,
  ): boolean {
    const normalized = normalizeSignal(signal);
    const pid = this.pid;
    if (!pid) {
      append({
        kind: "signal-refused",
        pid: 0,
        signal: normalized,
        startIdentity: null,
        reason: "missing-pid",
      });
      return false;
    }
    const startIdentity = readStartIdentity(pid);
    const owned = startIdentity ? acquiredMatch(pid, startIdentity) : null;
    if (!owned || !startIdentity) {
      append({
        kind: "signal-refused",
        pid,
        signal: normalized,
        startIdentity,
        reason: startIdentity ? "not-acquired" : "process-absent",
      });
      return false;
    }
    append({
      kind: "signal-requested",
      role: owned.role,
      pid,
      signal: normalized,
      startIdentity,
    });
    const sent = originalKill.call(this, normalized);
    append(
      sent
        ? {
            kind: "signal-sent",
            role: owned.role,
            pid,
            signal: normalized,
            startIdentity,
          }
        : {
            kind: "signal-refused",
            pid,
            signal: normalized,
            startIdentity,
            reason: "kill-returned-false",
          },
    );
    return sent;
  };

  const nodeRequire = createRequire(import.meta.url);
  const builtin: unknown = nodeRequire("node:child_process");
  if (typeof builtin !== "object" || builtin === null) {
    throw new Error("child_process is unavailable");
  }
  wrapChildFactory(builtin, "spawn");
  wrapChildFactory(builtin, "fork");
}

function watch(child: ChildProcess): ChildProcess {
  const note = () => {
    observeChild(child);
  };
  if (child.pid) {
    note();
  }
  child.on("spawn", note);
  return child;
}

function ppid(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const line = status.split("\n").find((entry) => entry.startsWith("PPid:"));
    if (!line) {
      return null;
    }
    const value = Number(line.slice("PPid:".length).trim());
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function recordDescendants(rootPid: number): number[] {
  const rootStart = readStartIdentity(rootPid);
  if (!rootStart || !acquiredMatch(rootPid, rootStart)) {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    const parent = ppid(pid);
    if (parent === null) {
      continue;
    }
    const list = children.get(parent) ?? [];
    list.push(pid);
    children.set(parent, list);
  }
  const found: number[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const startIdentity = readStartIdentity(pid);
    if (!startIdentity) {
      continue;
    }
    acquire({
      role: "descendant",
      pid,
      startIdentity,
      command: commandOf(pid),
    });
    found.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return found;
}

export function launcherPid(): number | null {
  let pid: number | null = null;
  for (const row of readJournal()) {
    if (row.kind !== "acquired" || row.role !== "launcher") {
      continue;
    }
    if (readStartIdentity(row.pid) === row.startIdentity) {
      pid = row.pid;
    }
  }
  return pid;
}

export function ownedLivePids(roles: readonly ProcessRole[]): number[] {
  const live: number[] = [];
  for (const row of readJournal()) {
    if (row.kind !== "acquired" || !roles.includes(row.role)) {
      continue;
    }
    if (readStartIdentity(row.pid) === row.startIdentity) {
      live.push(row.pid);
    }
  }
  return [...new Set(live)];
}

export function exePath(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

export function processesMentioning(needle: string): number[] {
  const hits: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const pid = Number(name);
    if (commandOf(pid).includes(needle)) {
      hits.push(pid);
    }
  }
  return hits;
}
