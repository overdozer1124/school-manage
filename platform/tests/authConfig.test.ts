import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { loadAuthConfig } from "../src/auth/config.js";
import {
  candidateMemberships,
  isMembershipCandidate,
  todayString,
} from "../src/auth/membership.js";
import { createLoginOAuthState, parseLoginOAuthState } from "../src/auth/oauthState.js";
import {
  expiresInToSeconds,
  hashPassword,
  signSelectionToken,
  signSessionToken,
  verifyAuthToken,
  verifyPassword,
} from "../src/auth/tokens.js";

// Unit tests for the pieces of Issue #5 that do not need a database:
// configuration loading (the startup gate), the OAuth state signature,
// the membership judgment and the token shape.

describe("loadAuthConfig", () => {
  it("refuses to load without JWT_SECRET (the platform must not start)", () => {
    expect(() => loadAuthConfig({})).toThrow(/JWT_SECRET/);
    expect(() => loadAuthConfig({ JWT_SECRET: "" })).toThrow(/JWT_SECRET/);
  });

  it("loads with a secret and applies the source defaults", () => {
    const config = loadAuthConfig({ JWT_SECRET: "unit-test-secret" });
    expect(config.jwtSecret).toBe("unit-test-secret");
    expect(config.jwtExpiresIn).toBe("7d");
    expect(config.googleClientId).toBeUndefined();
  });

  it("refuses JWT_EXPIRES_IN shapes the cookie lifetime cannot mirror", () => {
    const base = { JWT_SECRET: "unit-test-secret" };
    expect(() => loadAuthConfig({ ...base, JWT_EXPIRES_IN: "3600" })).toThrow(/JWT_EXPIRES_IN/);
    expect(() => loadAuthConfig({ ...base, JWT_EXPIRES_IN: "7 days" })).toThrow(/JWT_EXPIRES_IN/);
    expect(loadAuthConfig({ ...base, JWT_EXPIRES_IN: "12h" }).jwtExpiresIn).toBe("12h");
  });

  it("requires the Google pair to be set together", () => {
    expect(() =>
      loadAuthConfig({ JWT_SECRET: "unit-test-secret", GOOGLE_CLIENT_ID: "id-only" }),
    ).toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  });
});

describe("OAuth state", () => {
  const secret = "unit-test-secret";

  it("round-trips a school id", () => {
    const state = createLoginOAuthState(secret, "school-a");
    expect(parseLoginOAuthState(secret, state)).toEqual({ schoolId: "school-a" });
  });

  it("round-trips without a school id", () => {
    const state = createLoginOAuthState(secret);
    expect(parseLoginOAuthState(secret, state)).toEqual({});
  });

  it("refuses a tampered state and a state signed with another secret", () => {
    const state = createLoginOAuthState(secret, "school-a");
    const tampered = state.replace("school-a", "school-b");
    expect(() => parseLoginOAuthState(secret, tampered)).toThrow();
    expect(() => parseLoginOAuthState("another-secret", state)).toThrow();
    expect(() => parseLoginOAuthState(secret, "not-a-state")).toThrow();
  });
});

describe("membership candidacy", () => {
  const today = "2026-11-08";
  const base = { startsOn: null, endsOn: null };

  it("accepts approved memberships inside the period only", () => {
    expect(isMembershipCandidate({ ...base, status: "approved" }, today)).toBe(true);
    expect(isMembershipCandidate({ ...base, status: "invited" }, today)).toBe(false);
    expect(isMembershipCandidate({ ...base, status: "suspended" }, today)).toBe(false);
    expect(
      isMembershipCandidate({ status: "approved", startsOn: "2026-11-09", endsOn: null }, today),
    ).toBe(false);
    expect(
      isMembershipCandidate({ status: "approved", startsOn: null, endsOn: "2026-11-07" }, today),
    ).toBe(false);
    expect(
      isMembershipCandidate(
        { status: "approved", startsOn: "2026-11-08", endsOn: "2026-11-08" },
        today,
      ),
    ).toBe(true);
  });

  it("filters a mixed list", () => {
    const rows = [
      { status: "approved", startsOn: null, endsOn: null, schoolId: "a" },
      { status: "invited", startsOn: null, endsOn: null, schoolId: "b" },
    ] as const;
    expect(candidateMemberships([...rows], today).map((m) => m.schoolId)).toEqual(["a"]);
  });

  it("offers one candidate per school, the later-starting row (Issue #14)", () => {
    const rows = [
      { status: "approved", startsOn: "2020-04-01", endsOn: null, schoolId: "a", id: "old" },
      { status: "approved", startsOn: "2025-04-01", endsOn: null, schoolId: "a", id: "new" },
      { status: "approved", startsOn: null, endsOn: null, schoolId: "b", id: "other" },
    ] as const;
    const result = candidateMemberships([...rows], today);
    expect(result.map((m) => m.schoolId).sort()).toEqual(["a", "b"]);
    expect(result.find((m) => m.schoolId === "a")?.id).toBe("new");
  });
});

describe("tokens and passwords", () => {
  const config = loadAuthConfig({ JWT_SECRET: "unit-test-secret" });

  it("session tokens carry person and school, and no role", () => {
    const token = signSessionToken(config, {
      personId: "person-1",
      schoolId: "school-a",
      email: "a@example.jp",
    });
    const claims = verifyAuthToken(config, token);
    expect(claims).toEqual({
      personId: "person-1",
      schoolId: "school-a",
      email: "a@example.jp",
    });
    expect(claims !== null && "role" in claims).toBe(false);
  });

  it("selection tokens are distinguishable and carry no school", () => {
    const token = signSelectionToken(config, "person-1");
    expect(verifyAuthToken(config, token)).toEqual({
      personId: "person-1",
      purpose: "school-selection",
    });
  });

  it("refuses tokens signed with a different algorithm (HS256 only)", () => {
    const token = jwt.sign(
      { personId: "person-1", schoolId: "school-a", email: "a@example.jp" },
      "unit-test-secret",
      { algorithm: "HS512", expiresIn: "1h" },
    );
    expect(verifyAuthToken(config, token)).toBeNull();
  });

  it("refuses tokens signed with another secret and garbage", () => {
    const other = loadAuthConfig({ JWT_SECRET: "another-secret" });
    const token = signSessionToken(other, {
      personId: "person-1",
      schoolId: "school-a",
      email: "a@example.jp",
    });
    expect(verifyAuthToken(config, token)).toBeNull();
    expect(verifyAuthToken(config, "not-a-token")).toBeNull();
  });

  it("hashes and verifies passwords (bcrypt, source parity)", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toContain("correct horse");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });
});

describe("todayString (Asia/Tokyo)", () => {
  it("turns over at midnight JST, not at 09:00 JST", () => {
    // 2026-03-31T16:00:00Z is 2026-04-01 01:00 in Tokyo: already April.
    expect(todayString(new Date("2026-03-31T16:00:00Z"))).toBe("2026-04-01");
    // One second before midnight JST it is still 31 March.
    expect(todayString(new Date("2026-03-31T14:59:59Z"))).toBe("2026-03-31");
    // Exactly midnight JST at the start of 2 April.
    expect(todayString(new Date("2026-04-01T15:00:00Z"))).toBe("2026-04-02");
  });
});

describe("expiresInToSeconds", () => {
  it("converts the shapes JWT_EXPIRES_IN takes", () => {
    expect(expiresInToSeconds("7d")).toBe(604_800);
    expect(expiresInToSeconds("12h")).toBe(43_200);
    expect(expiresInToSeconds("30m")).toBe(1_800);
    // A unit is required (loadAuthConfig refuses unit-less values,
    // which jsonwebtoken would read as milliseconds); the fallback
    // here is the 7-day default.
    expect(expiresInToSeconds("3600")).toBe(604_800);
    expect(expiresInToSeconds("bogus")).toBe(604_800);
  });
});
