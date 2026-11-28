import { createApp } from "./app.js";
import { loadAuthConfig } from "./auth/config.js";
import { loadChangesServiceConfig } from "./changes/routes.js";
import { loadPublicReadConfig } from "./publicRead/routes.js";
import {
  createAbsenceStoreFromEnv,
  createAbsenceSubdivisionStoreFromEnv,
  createAuthStoreFromEnv,
  createChangeStoreFromEnv,
  createDayStoreFromEnv,
  createEventStoreFromEnv,
  createHolidayStoreFromEnv,
  createMasterStoreFromEnv,
  createMembershipAdminStoreFromEnv,
  createWebhookStoreFromEnv,
} from "./db/runtime.js";
import { createWebhookDispatcher, loadWebhookDestinations } from "./webhooks/deliver.js";

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
const membershipStore = createMembershipAdminStoreFromEnv();

const port = Number(process.env.PLATFORM_PORT ?? 3001);

createApp({
  auth: { store, config: authConfig },
  changes: { config: authConfig, authStore: store, changeStore, ...loadChangesServiceConfig() },
  masters: { config: authConfig, authStore: store, masterStore },
  events: { config: authConfig, authStore: store, eventStore },
  calendar: { config: authConfig, authStore: store, dayStore, holidayStore },
  absences: { config: authConfig, authStore: store, absenceStore, subdivisionStore },
  members: { config: authConfig, authStore: store, membershipStore },
  publicRead: {
    authStore: store,
    dayStore,
    holidayStore,
    eventStore,
    masterStore,
    ...loadPublicReadConfig(),
  },
}).listen(port, () => {
  console.log(`platform listening on port ${port}`);
});

// Webhook delivery (Issue #106): only when at least one destination
// is configured. With none, nothing polls and nothing is sent — the
// platform behaves exactly as before.
const webhookDestinations = loadWebhookDestinations();
if (webhookDestinations.length > 0) {
  createWebhookDispatcher({
    store: createWebhookStoreFromEnv(),
    destinations: webhookDestinations,
  }).start();
  console.log(
    `webhook delivery enabled for: ${webhookDestinations.map((d) => d.product).join(", ")}`,
  );
}
