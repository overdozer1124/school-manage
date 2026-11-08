import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The developer copies .env.example to .env at the repository root
// (see README), but vitest does not read .env by itself. Load it here so
// the database integration tests do not get skipped silently just
// because the shell did not export the variables.
const rootEnv = new URL("../.env", import.meta.url);
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
