import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const instanceIdentity = `instance:${randomBytes(16).toString("hex")}`;

export function processIdentity(pid: number): string {
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    if (!boot || !start || !/^\d+$/.test(start)) throw new Error("Process identity unavailable");
    return `${boot}:${start}`;
  } catch (error) {
    // Outside Linux, our own lease still has an identity; other live PIDs remain conservative.
    if (pid === process.pid && (error as NodeJS.ErrnoException).code === "ENOENT") return instanceIdentity;
    throw error;
  }
}

export function ownerIsStale(owner: { pid: number; process_identity?: string }): boolean {
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  if (!owner.process_identity) return false;
  try { return processIdentity(owner.pid) !== owner.process_identity; }
  catch { return false; }
}

export function acquireStorageLease(directory: string): { identity: string; release: () => void } {
  const identity = processIdentity(process.pid);
  const instance = randomBytes(16).toString("hex");
  const candidate = join(directory, `.desktop-lease-candidate-${instance}`);
  const lease = join(directory, ".desktop-lease");
  mkdirSync(candidate, { mode: 0o700 });
  try {
    writeFileSync(join(candidate, "owner.json"), JSON.stringify({ pid: process.pid, process_identity: identity, instance }), { mode: 0o600 });
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        // A prepared nonempty directory cannot replace another nonempty lease.
        renameSync(candidate, lease);
        let heldPath = lease;
        const detached = join(directory, `.desktop-lease-release-${instance}`);
        return { identity, release: () => {
          // Detach the whole lease before cleanup so a contender never observes an empty lease.
          if (heldPath === lease) { renameSync(lease, detached); heldPath = detached; }
          rmSync(heldPath, { recursive: true });
        } };
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      let owner: { pid: number; process_identity: string; instance: string };
      try { owner = JSON.parse(readFileSync(join(lease, "owner.json"), "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647 ||
          !/^[a-f0-9]{32}$/.test(owner.instance) || typeof owner.process_identity !== "string" || !ownerIsStale(owner)) {
        throw new Error("Data directory is already owned; stop the other process before opening another writer");
      }
      try {
        // Retain the nonempty destination: a second stale observer cannot retire a new lease.
        renameSync(lease, join(directory, `.desktop-lease-retired-${owner.instance}`));
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    throw new Error("Data directory ownership changed repeatedly; retry startup");
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}
