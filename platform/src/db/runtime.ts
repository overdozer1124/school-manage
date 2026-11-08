import { createAuthStore, type AuthStore } from "./authStore.js";
import { createDb } from "./client.js";

/**
 * Composition helper for the process entry point: builds the auth store
 * from the environment connection string. It lives in src/db so the raw
 * client stays behind the tenancy guard (see eslint.config.mjs); the
 * entry point itself never imports the client module.
 */
export function createAuthStoreFromEnv(): AuthStore {
  const { db } = createDb();
  return createAuthStore(db);
}
