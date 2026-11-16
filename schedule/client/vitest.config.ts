import { fileURLToPath } from "node:url";
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
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    // The panel screens (settings / confirmation queue / duty)
    // render the whole app plus a large dialog, and a single test
    // chains several waitFor rounds; under a full parallel run
    // that legitimately takes longer than vitest's 5s default
    // (PR #78 re-review: the scenario-7 settings test timed out
    // on every full run while passing alone in ~370ms).
    testTimeout: 20000,
  },
});
