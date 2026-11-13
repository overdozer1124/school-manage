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
