import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Containers can take a minute to pull on a cold machine.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
