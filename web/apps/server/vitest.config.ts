import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // CI runners (shared, modest-spec ubuntu-latest) are noticeably slower
    // than local dev machines for real filesystem/chokidar/sqlite work this
    // suite does. Vitest's defaults (5000ms test / 10000ms hook) are tuned
    // for pure-unit suites and were causing sporadic, non-deterministic CI
    // failures across different tests each run (profile-sync's chokidar
    // watcher, source-docs' real fs + db work, golden-eval's setup hook).
    // Raise the global defaults instead of chasing one flaky test at a time.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
