import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the screens (Issue #34): jsdom + Testing Library,
 * kept apart from the server suite (schedule/vitest.config.ts),
 * whose tests rebuild a database schema. The schedule package's
 * test script runs both suites.
 */
export default defineConfig({
  // The config lives in client/, and so do its tests, whichever
  // directory vitest was started from.
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "jsdom",
  },
});
