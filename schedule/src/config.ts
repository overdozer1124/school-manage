/**
 * Schedule server configuration, read once at startup. Like the
 * platform's auth config, a missing required value stops the process
 * instead of starting with an unsafe or surprising default.
 */
export interface ScheduleConfig {
  /** Port the schedule server listens on (SCHEDULE_PORT, default 3002). */
  port: number;
  /** Origin of the platform service, without a trailing slash. */
  platformBaseUrl: string;
  /** SCHEDULE_DATABASE_URL (presence checked here; the client reads it). */
  databaseUrl: string;
  /** True when the development auth adapter is explicitly enabled. */
  devAuth: boolean;
  /**
   * The service credential for the platform's public-read path
   * (PUBLIC_READ_SERVICE_TOKEN), presented on the public viewing
   * reads (Issue #82). Optional here: when it is unset the platform
   * refuses those reads (401) and the public pages cannot open —
   * the credential is the platform's to require, and this server
   * never invents a default for it.
   */
  publicReadServiceToken: string | undefined;
}

export function loadScheduleConfig(env: NodeJS.ProcessEnv = process.env): ScheduleConfig {
  const databaseUrl = env.SCHEDULE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("SCHEDULE_DATABASE_URL is not set. The schedule server refuses to start.");
  }
  const platformBaseUrl = env.PLATFORM_BASE_URL;
  if (!platformBaseUrl) {
    throw new Error("PLATFORM_BASE_URL is not set. The schedule server refuses to start.");
  }
  const portRaw = env.SCHEDULE_PORT;
  const port = portRaw === undefined ? 3002 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SCHEDULE_PORT is not a valid port: ${portRaw}`);
  }
  return {
    port,
    platformBaseUrl: platformBaseUrl.replace(/\/+$/, ""),
    databaseUrl,
    devAuth: env.PLATFORM_DEV_AUTH === "1",
    publicReadServiceToken: env.PUBLIC_READ_SERVICE_TOKEN || undefined,
  };
}
