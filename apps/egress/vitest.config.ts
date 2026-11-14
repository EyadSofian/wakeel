import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test talks to local servers only; nothing here should take long.
    testTimeout: 10_000,
  },
});
