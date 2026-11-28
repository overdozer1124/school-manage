import {
  createAbsenceStore,
  createAbsenceSubdivisionStore,
  type AbsenceStore,
  type AbsenceSubdivisionStore,
} from "./absences.js";
import { createAuthStore, type AuthStore } from "./authStore.js";
import { createChangeStore, type ChangeStore } from "./changes.js";
import { createDb } from "./client.js";
import { createDayStore, createHolidayStore, type DayStore, type HolidayStore } from "./days.js";
import { createEventStore, type EventStore } from "./events.js";
import { createMasterStore, type MasterStore } from "./masters.js";
import { runMigrations } from "./migrate.js";
import {
  setupPlatformAdmin,
  setupSchool,
  type SetupPlatformAdminInput,
  type SetupPlatformAdminResult,
  type SetupSchoolInput,
  type SetupSchoolResult,
} from "./setup.js";
import { createWebhookStore, type WebhookStore } from "./webhooks.js";

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

export function createEventStoreFromEnv(): EventStore {
  const { db } = createDb();
  return createEventStore(db);
}

export function createDayStoreFromEnv(): DayStore {
  const { db } = createDb();
  return createDayStore(db);
}

export function createHolidayStoreFromEnv(): HolidayStore {
  const { db } = createDb();
  return createHolidayStore(db);
}

export function createAbsenceStoreFromEnv(): AbsenceStore {
  const { db } = createDb();
  return createAbsenceStore(db);
}

export function createAbsenceSubdivisionStoreFromEnv(): AbsenceSubdivisionStore {
  const { db } = createDb();
  return createAbsenceSubdivisionStore(db);
}

export function createWebhookStoreFromEnv(): WebhookStore {
  const { db } = createDb();
  return createWebhookStore(db);
}

/**
 * Production startup (Issue #132): applies pending migrations on the
 * platform database, then closes the connection again. The entry
 * point calls this before it starts listening when
 * NODE_ENV=production, so a deployed process never serves against an
 * unmigrated schema. The migrations folder is passed in by the entry
 * point: its location relative to the entry file is the same in the
 * src/ layout and in the bundled dist/ layout, while this module's
 * own location differs between the two.
 */
export async function runMigrationsFromEnv(migrationsFolder: string): Promise<void> {
  const { db, queryClient } = createDb();
  try {
    await runMigrations(db, migrationsFolder);
  } finally {
    await queryClient.end();
  }
}

/**
 * The operator setup commands (Issue #127, src/setup/cli.ts): one
 * runner owns the connection, applies pending migrations first (an
 * empty database is a valid starting point), and closes the client
 * when the command finishes.
 */
export interface SetupRunner {
  setupSchool(input: SetupSchoolInput): Promise<SetupSchoolResult>;
  setupPlatformAdmin(input: SetupPlatformAdminInput): Promise<SetupPlatformAdminResult>;
  close(): Promise<void>;
}

export function createSetupRunnerFromEnv(): SetupRunner {
  const { db, queryClient } = createDb();
  return {
    async setupSchool(input) {
      await runMigrations(db);
      return setupSchool(db, input);
    },
    async setupPlatformAdmin(input) {
      await runMigrations(db);
      return setupPlatformAdmin(db, input);
    },
    async close() {
      await queryClient.end();
    },
  };
}
