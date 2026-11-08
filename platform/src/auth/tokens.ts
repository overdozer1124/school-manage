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

export interface SessionClaims {
  personId: string;
  schoolId: string;
  email: string;
}

export interface SelectionClaims {
  personId: string;
  purpose: "school-selection";
}

export type TokenClaims = SessionClaims | SelectionClaims;

export function isSelectionClaims(claims: TokenClaims): claims is SelectionClaims {
  return "purpose" in claims && claims.purpose === "school-selection";
}

export function signSessionToken(config: AuthConfig, claims: SessionClaims): string {
  return jwt.sign({ ...claims }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: "HS256",
  } as jwt.SignOptions);
}

/** Short-lived token that may only be exchanged for a school choice. */
export function signSelectionToken(config: AuthConfig, personId: string): string {
  const claims: SelectionClaims = { personId, purpose: "school-selection" };
  return jwt.sign({ ...claims }, config.jwtSecret, { expiresIn: "10m", algorithm: "HS256" });
}

/**
 * Seconds for a jsonwebtoken-style expiry ("7d", "12h", "30m", "3600"),
 * so the cookie's Max-Age can follow JWT_EXPIRES_IN instead of drifting
 * away from it. Unrecognised shapes fall back to the 7-day default.
 */
export function expiresInToSeconds(expiresIn: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(expiresIn.trim());
  if (!match) return 7 * 24 * 60 * 60;
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "d" ? 86_400 : unit === "h" ? 3_600 : unit === "m" ? 60 : 1;
  return value * multiplier;
}

export function verifyAuthToken(config: AuthConfig, token: string): TokenClaims | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;
    if (typeof decoded.personId !== "string") return null;
    if (decoded.purpose === "school-selection") {
      return { personId: decoded.personId, purpose: "school-selection" };
    }
    if (typeof decoded.schoolId !== "string" || typeof decoded.email !== "string") {
      return null;
    }
    return { personId: decoded.personId, schoolId: decoded.schoolId, email: decoded.email };
  } catch {
    return null;
  }
}
