import { describe, expect, it } from "vitest";
import { loadAuthConfig } from "../src/auth/config.js";
import { candidateMemberships, isMembershipCandidate } from "../src/auth/membership.js";
import { createLoginOAuthState, parseLoginOAuthState } from "../src/auth/oauthState.js";
import {
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
