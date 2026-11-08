/**
 * Auth configuration, read from the environment only.
 *
 * JWT_SECRET has no default and no fallback: school-timetable carried a
 * well-known placeholder default ('your-secret-key-change-in-production'),
 * and Issue #5 explicitly forbids bringing it over. When the variable is
 * unset or empty, loading the configuration throws, and because the entry
 * point loads it before listening, the process does not start.
 */
export interface AuthConfig {
  jwtSecret: string;
  /** jsonwebtoken expiry for session tokens (source default: "7d"). */
  jwtExpiresIn: string;
  googleClientId?: string | undefined;
  googleClientSecret?: string | undefined;
  /** Source parity: platform operators may not use Google login unless set. */
  allowSuperAdminGoogleLogin: boolean;
  /** Failed password logins allowed per email address before a 429 (Issue #16). */
  loginRateLimitMaxFailures: number;
  /** The sliding window those failures are counted in, in seconds. */
  loginRateLimitWindowSeconds: number;
  /**
   * The same window's allowance per source address. Deliberately far
   * larger than the per-email limit: a whole school's teachers share
   * one outward address (NAT), so a per-source limit as small as the
   * per-email one would lock out colleagues who typed nothing wrong.
   */
  loginRateLimitIpMaxFailures: number;
  /**
   * Express's "trust proxy" setting, from TRUST_PROXY (for example
   * "loopback"). Unset by default: without it Express ignores
   * X-Forwarded-For, and behind the reverse proxy of DESIGN 8-3-1
   * every request would carry the proxy's own address — set it there
   * so req.ip is the real source.
   */
  trustProxy: string | undefined;
}

function positiveIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}").`);
  }
  return Number(raw);
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error(
      "JWT_SECRET is not set. The platform refuses to start without it; " +
        "there is intentionally no default value.",
    );
  }

  // JWT_EXPIRES_IN must be a number with an explicit unit (s/m/h/d).
  // jsonwebtoken also accepts shapes like "7 days" or a bare "3600"
  // (which it reads as milliseconds), but the session cookie's Max-Age
  // is derived from this value in whole seconds — shapes the two sides
  // would read differently are refused here so they can never drift.
  const jwtExpiresIn = env.JWT_EXPIRES_IN || "7d";
  if (!/^\d+[smhd]$/.test(jwtExpiresIn)) {
    throw new Error(
      'JWT_EXPIRES_IN must be a number followed by one of s, m, h, d (for example "7d" or "12h").',
    );
  }

  const googleClientId = env.GOOGLE_CLIENT_ID || undefined;
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET || undefined;
  if ((googleClientId === undefined) !== (googleClientSecret === undefined)) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together (or both unset).",
    );
  }

  return {
    jwtSecret,
    jwtExpiresIn,
    googleClientId,
    googleClientSecret,
    allowSuperAdminGoogleLogin:
      env.ALLOW_SUPERADMIN_GOOGLE_LOGIN === "true" || env.ALLOW_SUPERADMIN_GOOGLE_LOGIN === "1",
    loginRateLimitMaxFailures: positiveIntEnv(env, "LOGIN_RATE_LIMIT_MAX_FAILURES", 10),
    loginRateLimitWindowSeconds: positiveIntEnv(env, "LOGIN_RATE_LIMIT_WINDOW_SECONDS", 900),
    loginRateLimitIpMaxFailures: positiveIntEnv(env, "LOGIN_RATE_LIMIT_IP_MAX_FAILURES", 100),
    trustProxy: env.TRUST_PROXY || undefined,
  };
}
