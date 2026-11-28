/**
 * Platform server listen configuration, read once at startup (the
 * schedule server resolves its own the same way in
 * schedule/src/config.ts). A malformed port stops the process
 * instead of starting with a surprising value.
 */
export interface ServerConfig {
  /** Port the platform server listens on (PLATFORM_PORT, default 3001). */
  port: number;
  /**
   * Address the platform server listens on (PLATFORM_HOST).
   * Undefined means "all interfaces", the historical behaviour, and
   * is what development keeps. In production (NODE_ENV=production)
   * the default is 127.0.0.1 instead: the service sits behind nginx
   * on the same host (DESIGN 8-3-1), and listening on all interfaces
   * would let callers reach it directly over plain HTTP — logins
   * included — bypassing nginx and TLS entirely, whenever the host
   * firewall leaves the port open (PR #139 review).
   */
  host: string | undefined;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const portRaw = env.PLATFORM_PORT;
  const port = portRaw === undefined ? 3001 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PLATFORM_PORT is not a valid port: ${portRaw}`);
  }
  const host = env.PLATFORM_HOST || (env.NODE_ENV === "production" ? "127.0.0.1" : undefined);
  return { port, host };
}
