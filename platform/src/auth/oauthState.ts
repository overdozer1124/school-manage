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
 * How long a state stays usable (Issue #16). The state is created
 * when the login page asks for the Google URL and spent at the
 * callback; ten minutes is ample for a person to pick an account,
 * and a state replayed later than that is refused.
 */
export const LOGIN_OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Builds a state with a CSRF nonce; a school id and the browser
 * binding are embedded under the signature. Format:
 * login-{ts}-{rand}[|school={id}][|bind={random}]|sig={hmac}
 *
 * The binding is a random value the caller also sets as a short-lived
 * cookie (see routes.ts): the callback only accepts a state whose
 * binding matches the cookie, so a state created in one browser
 * cannot be spent in another.
 */
export function createLoginOAuthState(
  secret: string,
  schoolId?: string,
  binding?: string,
  nowMs: number = Date.now(),
): string {
  const nonce = `${STATE_PREFIX}${nowMs}-${randomBytes(8).toString("hex")}`;
  const trimmed = schoolId?.trim();
  let payload = trimmed ? `${nonce}|school=${trimmed}` : nonce;
  if (binding) payload = `${payload}|bind=${binding}`;
  return `${payload}|sig=${signPayload(secret, payload)}`;
}

/**
 * Verifies the signature, the age and (when expectedBinding is given)
 * the browser binding, and extracts the school id. Tampered or
 * malformed states are refused (400 for shape, 403 for signature,
 * expiry and binding, matching the source's BAD_REQUEST / FORBIDDEN
 * split).
 */
export function parseLoginOAuthState(
  secret: string,
  state: string,
  options: { expectedBinding?: string; nowMs?: number } = {},
): LoginOAuthStateParts {
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

  const tsMatch = /^login-(\d+)-/.exec(payload);
  if (!tsMatch) {
    throw new AuthError(400, "無効な認証 state です");
  }
  const ageMs = (options.nowMs ?? Date.now()) - Number(tsMatch[1]);
  if (ageMs > LOGIN_OAUTH_STATE_MAX_AGE_MS || ageMs < -60_000) {
    throw new AuthError(403, "認証 state の有効期限が切れています。再度ログインしてください。");
  }

  if (options.expectedBinding !== undefined) {
    const bindMatch = /(?:^|\|)bind=([^|]+)/.exec(payload);
    if (!bindMatch || bindMatch[1] !== options.expectedBinding) {
      throw new AuthError(
        403,
        "認証 state がこのブラウザで作られたものではありません。再度ログインしてください。",
      );
    }
  }

  const schoolMatch = /(?:^|\|)school=([^|]+)/.exec(payload);
  const schoolId = schoolMatch?.[1]?.trim();
  return schoolId ? { schoolId } : {};
}
