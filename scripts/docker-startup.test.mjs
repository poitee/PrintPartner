import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("runtime image lets the entrypoint repair data ownership before dropping privileges", () => {
  const runtime = read("Dockerfile").split(/^FROM .+ AS runtime\s*$/im)[1];
  assert.ok(runtime, "Dockerfile must contain a runtime stage");
  assert.doesNotMatch(runtime, /^\s*USER\s+/im);
  assert.match(runtime, /^ENTRYPOINT \["docker-entrypoint.sh"\]$/m);
  assert.match(runtime, /^CMD \["node",\s*"dist\/current\/index.js"\]$/m);

  const entrypoint = read("docker-entrypoint.sh");
  assert.match(entrypoint, /if \[ "\$\(id -u\)" = "0" \]; then\s+mkdir -p \/data\s+chown -R ppuser:ppuser \/data\s+run_as_ppuser "\$@"/);
  assert.match(entrypoint, /exec gosu ppuser dumb-init -- "\$@"/);
  assert.match(entrypoint, /exec su-exec ppuser dumb-init -- "\$@"/);
});

for (const path of ["docker-compose.yml", "docker-compose.saas.yml", "pp-compose.yml"]) {
  test(`${path} preserves the application entrypoint and initial user`, () => {
    const service = read(path).match(/^  print-partner:\n([\s\S]*?)(?=^  [\w-]+:|^\S|$(?![\s\S]))/m)?.[1];
    assert.ok(service, "Compose must declare the print-partner service");
    assert.doesNotMatch(service, /^    (?:user|entrypoint):/m);
  });
}
