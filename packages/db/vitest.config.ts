import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One Postgres container per run; every test file connects to it (see test/global-setup.ts).
    globalSetup: ["./test/global-setup.ts"],
    // Pulling the image on a cold machine can take a minute.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
