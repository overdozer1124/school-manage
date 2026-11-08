import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AuthError } from "./errors.js";

/**
 * Google login OAuth state, ported from school-timetable's
 * services/oauthLoginState.ts: the school id travels inside an
 * HMAC-signed state so the callback can trust it. One deliberate change:
 * the signing secret is the platform's JWT_SECRET passed in by the
 * caller — the source silently fell back to a well-known placeholder
 * when no secret was configured, and that fallback is not carried over.
 */

const STATE_PREFIX = "login-";

function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export interface LoginOAuthStateParts {
  /** The school id whose signature was verified. Absent when unspecified. */
  schoolId?: string;
}

/**
 * Builds a state with a CSRF nonce; a school id is embedded under the
 * signature. Format: login-{ts}-{rand}[|school={id}]|sig={hmac}
 */
export function createLoginOAuthState(secret: string, schoolId?: string): string {
  const nonce = `${STATE_PREFIX}${Date.now()}-${randomBytes(8).toString("hex")}`;
  const trimmed = schoolId?.trim();
  const payload = trimmed ? `${nonce}|school=${trimmed}` : nonce;
  return `${payload}|sig=${signPayload(secret, payload)}`;
}

/**
 * Verifies the signature and extracts the school id. Tampered or
 * malformed states are refused (400 for shape, 403 for signature,
 * matching the source's BAD_REQUEST / FORBIDDEN split).
 */
export function parseLoginOAuthState(secret: string, state: string): LoginOAuthStateParts {
  const raw = state?.trim() ?? "";
  if (!raw.startsWith(STATE_PREFIX)) {
    throw new AuthError(400, "無効な認証 state です");
  }

  const sigSep = "|sig=";
  const sigIndex = raw.lastIndexOf(sigSep);
  if (sigIndex < 0) {
    throw new AuthError(400, "無効な認証 state です");
  }

  const payload = raw.slice(0, sigIndex);
  const sig = raw.slice(sigIndex + sigSep.length);
  if (!sig || !timingSafeEqualHex(sig, signPayload(secret, payload))) {
    throw new AuthError(403, "認証 state の検証に失敗しました。再度ログインしてください。");
  }

  const schoolMatch = /(?:^|\|)school=([^|]+)/.exec(payload);
  const schoolId = schoolMatch?.[1]?.trim();
  return schoolId ? { schoolId } : {};
}
