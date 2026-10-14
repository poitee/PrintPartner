import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import process from "node:process";
import console from "node:console";

const [root, scenario] = process.argv.slice(2);
delete process.env.PP_SOURCE_SYNC_OWNERSHIP_MANIFEST;
const { beginSourceSyncAdmission, sourceSyncAdmissionReceiptPath, OwnershipAdmissionError } =
  await import("../source-sync-admission.ts");
const dataDir = join(root, "data");
const first = beginSourceSyncAdmission(dataDir);
const receiptPath = sourceSyncAdmissionReceiptPath(dataDir);
const outside = join(root, "outside.json");
const outsideBytes = JSON.stringify({ ...first, worker_pid: 999 });
fs.writeFileSync(outside, outsideBytes);
let replaced = false;
let closed = false;
let receiptFd;
const replace = () => {
  if (replaced) return;
  replaced = true;
  fs.unlinkSync(receiptPath);
  if (scenario === "symlink") fs.symlinkSync(outside, receiptPath);
  else if (scenario === "fifo") {
    const result = spawnSync("mkfifo", [receiptPath]);
    assert.equal(result.status, 0);
  } else if (scenario === "directory") fs.mkdirSync(receiptPath);
  else fs.writeFileSync(receiptPath, "{replacement");
};
const actualLstat = fs.lstatSync;
fs.lstatSync = (path, ...args) => {
  const metadata = actualLstat(path, ...args);
  if (path === receiptPath) replace();
  return metadata;
};
const actualOpen = fs.openSync;
fs.openSync = (path, ...args) => {
  if (path === receiptPath && scenario !== "after-open") replace();
  const fd = actualOpen(path, ...args);
  if (path === receiptPath) receiptFd = fd;
  return fd;
};
const actualFstat = fs.fstatSync;
fs.fstatSync = (fd, ...args) => {
  const metadata = actualFstat(fd, ...args);
  if (fd === receiptFd && scenario === "after-open") replace();
  return metadata;
};
const actualClose = fs.closeSync;
fs.closeSync = (fd) => {
  if (fd === receiptFd) closed = true;
  return actualClose(fd);
};
syncBuiltinESMExports();
if (scenario === "after-open") assert.deepEqual(beginSourceSyncAdmission(dataDir), first);
else assert.throws(() => beginSourceSyncAdmission(dataDir), OwnershipAdmissionError);
assert.ok(replaced);
if (receiptFd !== undefined) assert.ok(closed);
assert.equal(fs.readFileSync(outside, "utf8"), outsideBytes);
if (scenario === "after-open") assert.equal(fs.readFileSync(receiptPath, "utf8"), "{replacement");
else assert.ok(!actualLstat(receiptPath).isFile());
console.log(`Validated opened receipt during ${scenario} replacement`);
