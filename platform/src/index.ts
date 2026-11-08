import { createApp } from "./app.js";
import { loadAuthConfig } from "./auth/config.js";
import { createAuthStoreFromEnv } from "./db/runtime.js";

// Loading the auth configuration comes first on purpose: without
// JWT_SECRET it throws, and the process stops instead of starting with
// an unsafe default (Issue #5).
const authConfig = loadAuthConfig();
const store = createAuthStoreFromEnv();

const port = Number(process.env.PLATFORM_PORT ?? 3001);

createApp({ auth: { store, config: authConfig } }).listen(port, () => {
  console.log(`platform listening on port ${port}`);
});
