import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { AuthConfig } from "./config.js";

/**
 * Password hashing and JWT issuing/verification, ported from
 * school-timetable's utils/auth.ts (bcrypt + jsonwebtoken, same cost).
 *
 * Deliberate differences for the platform model (Issue #5):
 * - The secret comes from AuthConfig, which refuses to load without
 *   JWT_SECRET; the source read a module-level constant with a
 *   well-known placeholder default.
 * - The token carries person_id and the chosen school_id only. Roles are
 *   NOT in the token: they are looked up from the database at verify
 *   time (Issue #6), so a role change takes effect immediately.
 */

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * How the person proved who they are when this token was issued
 * (Issue #140): the school scope of a password (see the persons
 * schema) is lifted only by a re-set made in a "google" session,
 * so the platform has to remember which proof a session — and the
 * selection step that may precede it — came from. Tokens issued
 * before this was recorded carry no authMethod; verification
 * leaves it absent and every consumer treats the absence as
 * "password", the safe side (such a token can never lift a scope).
 */
export type AuthMethod = "google" | "password";

export interface SessionClaims {
  personId: string;
  schoolId: string;
  email: string;
  authMethod?: AuthMethod;
}

export interface SelectionClaims {
  personId: string;
  purpose: "school-selection";
  authMethod?: AuthMethod;
}

/**
 * The token a password login hands out when the password was set by
 * an administrator and the person must change it first (Issue #140).
 * Like the selection token it names a person and nothing else — no
 * school, no session — and the only call that accepts it is the
 * password change itself.
 */
export interface PasswordChangeClaims {
  personId: string;
  purpose: "password-change";
}

export type TokenClaims = SessionClaims | SelectionClaims | PasswordChangeClaims;

export function isSelectionClaims(claims: TokenClaims): claims is SelectionClaims {
  return "purpose" in claims && claims.purpose === "school-selection";
}

/** The proof a session or selection token rests on; absent means "password". */
export function authMethodOf(claims: TokenClaims): AuthMethod {
  return "authMethod" in claims && claims.authMethod === "google" ? "google" : "password";
}

export function isPasswordChangeClaims(claims: TokenClaims): claims is PasswordChangeClaims {
  return "purpose" in claims && claims.purpose === "password-change";
}

export function signSessionToken(config: AuthConfig, claims: SessionClaims): string {
  return jwt.sign({ ...claims }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: "HS256",
  } as jwt.SignOptions);
}

/** Short-lived token that may only be exchanged for a school choice. */
export function signSelectionToken(
  config: AuthConfig,
  personId: string,
  authMethod?: AuthMethod,
): string {
  const claims: SelectionClaims = {
    personId,
    purpose: "school-selection",
    ...(authMethod ? { authMethod } : {}),
  };
  return jwt.sign({ ...claims }, config.jwtSecret, { expiresIn: "10m", algorithm: "HS256" });
}

/** Short-lived token that may only be spent on the password change (Issue #140). */
export function signPasswordChangeToken(config: AuthConfig, personId: string): string {
  const claims: PasswordChangeClaims = { personId, purpose: "password-change" };
  return jwt.sign({ ...claims }, config.jwtSecret, { expiresIn: "10m", algorithm: "HS256" });
}

/**
 * Seconds for a JWT_EXPIRES_IN value ("7d", "12h", "30m"), so the
 * cookie's Max-Age follows the token's own lifetime instead of drifting
 * away from it. loadAuthConfig only accepts this shape (a unit is
 * required — jsonwebtoken would read a bare number as milliseconds),
 * so the fallback here is unreachable for configured values.
 */
export function expiresInToSeconds(expiresIn: string): number {
  const match = /^(\d+)([smhd])$/.exec(expiresIn.trim());
  if (!match) return 7 * 24 * 60 * 60;
  const value = Number(match[1]);
  const unit = match[2] as string;
  const multiplier = unit === "d" ? 86_400 : unit === "h" ? 3_600 : unit === "m" ? 60 : 1;
  return value * multiplier;
}

export function verifyAuthToken(config: AuthConfig, token: string): TokenClaims | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;
    if (typeof decoded.personId !== "string") return null;
    // Only the exact "google" value is honoured; anything else —
    // including a token issued before authMethod was recorded —
    // leaves the claim absent, which consumers read as "password".
    const authMethod: AuthMethod | undefined =
      decoded.authMethod === "google" ? "google" : undefined;
    if (decoded.purpose === "school-selection") {
      return {
        personId: decoded.personId,
        purpose: "school-selection",
        ...(authMethod ? { authMethod } : {}),
      };
    }
    if (decoded.purpose === "password-change") {
      return { personId: decoded.personId, purpose: "password-change" };
    }
    if (typeof decoded.schoolId !== "string" || typeof decoded.email !== "string") {
      return null;
    }
    return {
      personId: decoded.personId,
      schoolId: decoded.schoolId,
      email: decoded.email,
      ...(authMethod ? { authMethod } : {}),
    };
  } catch {
    return null;
  }
}
