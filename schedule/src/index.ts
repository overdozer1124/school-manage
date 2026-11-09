import { createApp } from "./app.js";
import { loadScheduleConfig } from "./config.js";

// Loading the configuration comes first on purpose: without
// SCHEDULE_DATABASE_URL or PLATFORM_BASE_URL it throws, and the
// process stops instead of starting half-wired (the platform takes
// the same stance for its secrets).
const config = loadScheduleConfig();

createApp().listen(config.port, () => {
  console.log(`schedule listening on port ${config.port}`);
});
