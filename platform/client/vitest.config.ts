import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the login screens (Issue #129): jsdom + Testing
 * Library, kept apart from the server suite (platform/vitest.config.ts),
 * whose tests rebuild a database schema. The platform package's test
 * script runs both suites.
 */
export default defineConfig({
  // The config lives in client/, and so do its tests, whichever
  // directory vitest was started from.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    environment: "jsdom",
    testTimeout: 20000,
  },
});
