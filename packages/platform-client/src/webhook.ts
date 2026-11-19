import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The webhook wire format (Issue #106, DESIGN-INTEGRATION 7.1). The
 * platform signs every delivery with HMAC-SHA256 over
 * `${timestamp}.${rawBody}`, where the timestamp is the sending time
 * in whole seconds since the Unix epoch and rawBody is the exact
 * request body (a JSON text of `{ "events": [ChangeEvent, …] }`).
 * Both values travel in headers:
 *
 *   X-Platform-Timestamp: 1760000000
 *   X-Platform-Signature: sha256=<hex digest>
 *
 * The sender (the platform) and the receivers (the products) share
 * this module, so the construction cannot drift apart: the platform
 * signs with createWebhookSignature, a receiver checks an incoming
 * delivery with verifyWebhookSignature before trusting its body.
 */
export const WEBHOOK_TIMESTAMP_HEADER = "x-platform-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "x-platform-signature";

/** How far a delivery's timestamp may sit from the receiver's clock. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

function digest(secret: string, timestampSeconds: number, rawBody: string): Buffer {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest();
}

/**
 * The value of the X-Platform-Signature header for one delivery:
 * `sha256=` followed by the hex HMAC-SHA256 of
 * `${timestampSeconds}.${rawBody}` under the destination's secret.
 */
export function createWebhookSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return `sha256=${digest(secret, timestampSeconds, rawBody).toString("hex")}`;
}

export interface WebhookVerificationInput {
  /** The destination's shared secret (the receiver's own copy). */
  secret: string;
  /** The request body exactly as received — never a re-serialized parse. */
  rawBody: string;
  /** The X-Platform-Timestamp header value (whole seconds, decimal). */
  timestamp: string | number | undefined;
  /** The X-Platform-Signature header value (`sha256=<hex>`). */
  signature: string | undefined;
  /** Allowed clock distance in seconds. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** The receiver's clock, whole seconds since the epoch. Tests inject it. */
  nowSeconds?: number;
}

/**
 * Checks one delivery: the timestamp must be a whole number of
 * seconds within the tolerance of the receiver's clock (a replayed
 * old delivery is refused), and the signature must match the
 * recomputed HMAC under a constant-time comparison. Any malformed
 * piece is simply false — a receiver answers 401 without learning
 * which part failed.
 */
export function verifyWebhookSignature(input: WebhookVerificationInput): boolean {
  const tolerance = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  const timestampText =
    typeof input.timestamp === "number" ? String(input.timestamp) : input.timestamp;
  if (timestampText === undefined || !/^\d+$/.test(timestampText)) return false;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) return false;
  if (Math.abs(now - timestamp) > tolerance) return false;

  if (input.signature === undefined || !input.signature.startsWith("sha256=")) return false;
  const presented = Buffer.from(input.signature.slice("sha256=".length), "hex");
  const expected = digest(input.secret, timestamp, input.rawBody);
  // Buffer.from with "hex" silently truncates at the first non-hex
  // character, so a malformed value rarely has the digest's length;
  // the length check is what keeps timingSafeEqual (which throws on
  // unequal lengths) safe to call.
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
