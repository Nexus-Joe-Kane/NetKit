import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["tests/**"],
      reporter: ["text", "json-summary"],
    },
    environment: "node",
    exclude: process.env.RUN_INTEGRATION_TESTS === "1" ? [] : ["tests/integration/**"],
    globals: true,
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
