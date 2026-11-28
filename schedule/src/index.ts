import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createScheduleAuth } from "./auth.js";
import { createScheduleActions, createSchedulePublicActions } from "./composition.js";
import { loadScheduleConfig } from "./config.js";
import { createDbFromEnv, runMigrationsFromEnv } from "./db/runtime.js";
import { createPlatformApiClient } from "./platformClient.js";
import { createPublicPlatformClient } from "./publicViews/publicPlatform.js";

// Loading the configuration comes first on purpose: without
// SCHEDULE_DATABASE_URL or PLATFORM_BASE_URL it throws, and the
// process stops instead of starting half-wired (the platform takes
// the same stance for its secrets).
const config = loadScheduleConfig();

// Production startup (Issue #132): apply pending migrations before
// accepting traffic, so the process never serves against an
// unmigrated schema. Development keeps the explicit db:migrate step.
// The folder is resolved from this entry file: "../drizzle" names the
// schedule migrations folder both from src/index.ts and from the
// bundled dist/index.js.
if (process.env.NODE_ENV === "production") {
  await runMigrationsFromEnv(fileURLToPath(new URL("../drizzle", import.meta.url)));
}

const db = createDbFromEnv();
const platformClient = createPlatformApiClient({ baseUrl: config.platformBaseUrl });
// The public viewing reads (Issue #82) go through the platform's
// public-read path with the service credential, not the member
// client: there is no user's cookie to forward on that path.
const publicPlatformClient = createPublicPlatformClient({
  baseUrl: config.platformBaseUrl,
  serviceToken: config.publicReadServiceToken,
});
const auth = await createScheduleAuth({
  platformBaseUrl: config.platformBaseUrl,
  devAuth: config.devAuth,
});

createApp({
  auth,
  // TRUST_PROXY (Issue #41 re-review): behind the reverse proxy
  // this is what makes req.ip — and with it the public route's
  // per-source rate limit — name the real reader.
  trustProxy: config.trustProxy,
  // The actions are built per request: their platform reads and the
  // duty source forward the caller's own cookie (Issue #34).
  createActions: (cookie) => createScheduleActions(db, platformClient, cookie),
  // The public viewing actions (Issue #41) are built once: there
  // is no caller's cookie to bind — the token is the credential.
  createPublicActions: () => createSchedulePublicActions(db, publicPlatformClient),
}).listen(config.port, () => {
  console.log(`schedule listening on port ${config.port}`);
});
