import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // CLAUDE.md §7: engine code keeps at least 90% line coverage.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
