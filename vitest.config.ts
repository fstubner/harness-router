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
      // Keep the coverage gate focused on deterministic core logic. CLI
      // wrappers, host-install file edits, and the interactive onboard wizard
      // are covered by smoke/release checks and targeted tests where practical.
      exclude: [
        "src/bin.ts",
        "src/version.ts",
        "src/types.ts",
        "src/index.ts",
        "src/cli/**",
        "src/install/**",
        "src/onboarding/wizard.ts",
      ],
      // Thresholds calibrated from the v0.3.0 core baseline after excluding
      // interactive shells. Tighten as CLI/onboarding coverage gets deeper.
      thresholds: {
        lines: 80,
        branches: 65,
        functions: 75,
        statements: 75,
      },
    },
  },
});
