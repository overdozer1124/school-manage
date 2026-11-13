import { createApp } from "./app.js";
import { loadAuthConfig } from "./auth/config.js";
import {
  createAbsenceStoreFromEnv,
  createAbsenceSubdivisionStoreFromEnv,
  createAuthStoreFromEnv,
  createChangeStoreFromEnv,
  createDayStoreFromEnv,
  createEventStoreFromEnv,
  createHolidayStoreFromEnv,
  createMasterStoreFromEnv,
} from "./db/runtime.js";

// Loading the auth configuration comes first on purpose: without
// JWT_SECRET it throws, and the process stops instead of starting with
// an unsafe default (Issue #5).
const authConfig = loadAuthConfig();
const store = createAuthStoreFromEnv();
const changeStore = createChangeStoreFromEnv();
const masterStore = createMasterStoreFromEnv();
const eventStore = createEventStoreFromEnv();
const dayStore = createDayStoreFromEnv();
const holidayStore = createHolidayStoreFromEnv();
const absenceStore = createAbsenceStoreFromEnv();
const subdivisionStore = createAbsenceSubdivisionStoreFromEnv();

const port = Number(process.env.PLATFORM_PORT ?? 3001);

createApp({
  auth: { store, config: authConfig },
  changes: { config: authConfig, authStore: store, changeStore },
  masters: { config: authConfig, authStore: store, masterStore },
  events: { config: authConfig, authStore: store, eventStore },
  calendar: { config: authConfig, authStore: store, dayStore, holidayStore },
  absences: { config: authConfig, authStore: store, absenceStore, subdivisionStore },
}).listen(port, () => {
  console.log(`platform listening on port ${port}`);
});
