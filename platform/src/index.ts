import { createApp } from "./app.js";
import { loadAuthConfig } from "./auth/config.js";
import {
  createAuthStoreFromEnv,
  createChangeStoreFromEnv,
  createEventStoreFromEnv,
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

const port = Number(process.env.PLATFORM_PORT ?? 3001);

createApp({
  auth: { store, config: authConfig },
  changes: { config: authConfig, authStore: store, changeStore },
  masters: { config: authConfig, authStore: store, masterStore },
  events: { config: authConfig, authStore: store, eventStore },
}).listen(port, () => {
  console.log(`platform listening on port ${port}`);
});
