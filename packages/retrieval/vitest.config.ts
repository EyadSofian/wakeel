import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // ADR-007: the normaliser is the highest-leverage code in retrieval, so it keeps full coverage.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
