import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test talks to in-process fakes only; nothing here should take long.
    testTimeout: 10_000,
  },
});
