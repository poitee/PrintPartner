const fs = require("node:fs");
const http = require("node:http");
const readline = require("node:readline");

if (globalThis.gre448Preload !== "gre448-measured-simulator") {
  throw new Error("measured lifecycle preload did not execute");
}
// Ignore TERM so only observed stdin EOF can produce a successful exit.
process.on("SIGTERM", () => {});
const input = readline.createInterface({ input: process.stdin });
input.once("line", (line) => {
  const setup = JSON.parse(line);
  const events = `${setup.data_dir}/lifecycle-events`;
  const record = (event) => fs.appendFileSync(events, `${event}\n`);
  record(`SPAWN ${process.pid}`);
  input.once("close", () => {
    record(`EOF ${process.pid}`);
    process.exit(0);
  });
  process.once("exit", (code) => record(`EXIT ${process.pid} ${code}`));
  http.createServer((request, response) => {
    if (request.url === "/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        version: "0.0.0-gre448-simulator-web",
        release: { commit: process.env.PP_COMMIT },
      }));
      return;
    }
    if (request.url === "/stream") {
      record(`GET /stream ${process.pid}`);
      response.setHeader("Content-Type", "application/octet-stream");
      response.write(Buffer.alloc(1024 * 1024, 120));
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      record(`${request.method} ${request.url} ${body} ${process.pid}`);
      // Record the accepted effect and withhold its response.
    });
  }).listen(setup.socket_path);
});
