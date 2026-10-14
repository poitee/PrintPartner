const fs = require("node:fs");

if (process.stdin.readableFlowing !== null) {
  throw new Error("startup fixture stdin must remain unread");
}
const ready = process.argv[2];
fs.writeFileSync(ready + ".tmp", String(process.pid));
fs.renameSync(ready + ".tmp", ready);
setInterval(() => {}, 1e9);
