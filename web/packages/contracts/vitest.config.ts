import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Fails the run if a test leaves files in its temp dir (GRE-840).
    globalSetup: ["../../scripts/vitest-scratch-root.mjs"],
  },
});
