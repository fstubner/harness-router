import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov", "html"],
      include: ["src/**/*.ts"],
      // Don't penalise the bin entry-point or pure type files; they're
      // covered by smoke tests + tsc.
      exclude: ["src/bin.ts", "src/version.ts", "src/types.ts", "src/index.ts"],
      // Thresholds calibrated from the empirical 0.1.0 baseline (measured
      // 2026-05-01: 82.88 lines / 69.32 branches / 76.94 functions /
      // 79.83 statements). Set a few points below the baseline so a
      // regression trips the gate; planned to tighten as coverage grows.
      thresholds: {
        lines: 80,
        branches: 65,
        functions: 75,
        statements: 75,
      },
    },
  },
});
