const fs = require("node:fs");

if (globalThis.gre448Preload !== "gre448-measured-simulator") {
  throw new Error("measured startup preload did not execute");
}
const receipt = {
  pid: process.pid,
  preload: globalThis.gre448Preload,
  stdin_flowing: process.stdin.readableFlowing,
};
fs.writeFileSync("startup-executed.json.tmp", JSON.stringify(receipt));
fs.renameSync("startup-executed.json.tmp", "startup-executed.json");
setInterval(() => {}, 1e9);
