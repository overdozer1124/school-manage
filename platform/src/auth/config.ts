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
  };
}
