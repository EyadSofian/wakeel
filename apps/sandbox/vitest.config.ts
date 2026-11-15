import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // Each file starts its own pools of worker threads; running files one after another keeps the
    // deadline assertions honest on a loaded machine.
    fileParallelism: false,
  },
});
