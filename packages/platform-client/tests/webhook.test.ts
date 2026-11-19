import { describe, expect, it } from "vitest";
import { createWebhookSignature, verifyWebhookSignature } from "../src/webhook.js";

// Webhook signature tests (Issue #106): the receiver-side check the
// products run on every delivery. A delivery signed by
// createWebhookSignature passes; a tampered body, a wrong secret and
// a stale timestamp are each refused.
const SECRET = "webhook-test-secret";
const BODY = JSON.stringify({ events: [{ seq: 1, schoolId: "school-a" }] });
const NOW = 1_760_000_000;

describe("verifyWebhookSignature", () => {
  it("accepts a delivery signed with the shared construction", () => {
    const signature = createWebhookSignature(SECRET, NOW - 10, BODY);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestamp: String(NOW - 10),
        signature,
        nowSeconds: NOW,
      }),
    ).toBe(true);
    // A numeric timestamp header value is accepted too.
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestamp: NOW - 10,
        signature,
        nowSeconds: NOW,
      }),
    ).toBe(true);
  });

  it("rejects a body tampered with after signing", () => {
    const signature = createWebhookSignature(SECRET, NOW, BODY);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY.replace("school-a", "school-b"),
        timestamp: String(NOW),
        signature,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a signature made under a different secret", () => {
    const signature = createWebhookSignature("another-secret", NOW, BODY);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestamp: String(NOW),
        signature,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a timestamp outside the tolerance, in either direction", () => {
    const stale = NOW - 301;
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestamp: String(stale),
        signature: createWebhookSignature(SECRET, stale, BODY),
        nowSeconds: NOW,
      }),
    ).toBe(false);
    const future = NOW + 301;
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestamp: String(future),
        signature: createWebhookSignature(SECRET, future, BODY),
        nowSeconds: NOW,
      }),
    ).toBe(false);
    // The edge of the default 5-minute tolerance still passes.
    const edge = NOW - 300;
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        timestamp: String(edge),
        signature: createWebhookSignature(SECRET, edge, BODY),
        nowSeconds: NOW,
      }),
    ).toBe(true);
  });

  it("rejects missing and malformed pieces", () => {
    const signature = createWebhookSignature(SECRET, NOW, BODY);
    const base = { secret: SECRET, rawBody: BODY, nowSeconds: NOW };
    expect(verifyWebhookSignature({ ...base, timestamp: undefined, signature })).toBe(false);
    expect(verifyWebhookSignature({ ...base, timestamp: String(NOW), signature: undefined })).toBe(
      false,
    );
    expect(verifyWebhookSignature({ ...base, timestamp: "soon", signature })).toBe(false);
    expect(
      verifyWebhookSignature({ ...base, timestamp: String(NOW), signature: "sha256=zz" }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({ ...base, timestamp: String(NOW), signature: signature.slice(7) }),
    ).toBe(false);
  });
});
