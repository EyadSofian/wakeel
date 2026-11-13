import { defineConfig } from "vitest/config";

export default defineConfig({
  // Playwright owns *.spec.ts; Vitest runs unit tests only.
  test: { include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"] },
});
