import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Postgres and Redis containers start once per file; pulling images on a cold machine is slow.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
