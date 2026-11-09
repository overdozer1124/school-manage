import { createAuthStore, type AuthStore } from "./authStore.js";
import { createChangeStore, type ChangeStore } from "./changes.js";
import { createDb } from "./client.js";
import { createMasterStore, type MasterStore } from "./masters.js";

/**
 * Composition helpers for the process entry point: build the stores
 * from the environment connection string. They live in src/db so the
 * raw client stays behind the tenancy guard (see eslint.config.mjs);
 * the entry point itself never imports the client module.
 */
export function createAuthStoreFromEnv(): AuthStore {
  const { db } = createDb();
  return createAuthStore(db);
}

export function createChangeStoreFromEnv(): ChangeStore {
  const { db } = createDb();
  return createChangeStore(db);
}

export function createMasterStoreFromEnv(): MasterStore {
  const { db } = createDb();
  return createMasterStore(db);
}
