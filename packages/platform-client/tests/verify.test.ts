import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import {
  AuthAccessError,
  createPlatformClient,
  type PlatformClientOptions,
  type RequestLike,
} from "../src/index.js";

const SECRET = "client-test-secret";
const BASE = "http://platform.test";

function sessionToken(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    { personId: "p-1", schoolId: "school-a", email: "a@example.jp", ...overrides },
    SECRET,
    { algorithm: "HS256", expiresIn: "1h" },
  );
}

function reqWith(token: string | null): RequestLike {
  return { headers: token === null ? {} : { cookie: `platform_session=${token}` } };
}

function contextResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      userId: "p-1",
      schoolId: "school-a",
      product: "schedule",
      role: "Editor",
      isSuperAdmin: false,
      teacherId: "t-1",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<PlatformClientOptions> = {}) {
  return createPlatformClient({
    platformBaseUrl: BASE,
    jwtSecret: SECRET,
    product: "schedule",
    fetchImpl,
    ...extra,
  });
}

describe("verifyRequest", () => {
  it("returns the AuthContext for a valid token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => contextResponse());
    const client = makeClient(fetchImpl as typeof fetch);
    const context = await client.verifyRequest(reqWith(sessionToken()));
    expect(context).toEqual({
      userId: "p-1",
      schoolId: "school-a",
      role: "Editor",
      isSuperAdmin: false,
      personId: null,
      teacherId: "t-1",
    });
    const calledUrl = String((fetchImpl.mock.calls[0] as [string])[0]);
    expect(calledUrl).toBe(`${BASE}/platform/api/v1/auth/context?product=schedule`);
  });

  it("caches a successful lookup for the TTL and re-asks after it", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => contextResponse());
    const client = makeClient(fetchImpl as typeof fetch, { now: () => now });
    const req = reqWith(sessionToken());
    await client.verifyRequest(req);
    await client.verifyRequest(req);
    expect(fetchImpl.mock.calls.length).toBe(1);
    now += 31_000;
    await client.verifyRequest(req);
    expect(fetchImpl.mock.calls.length).toBe(2);
  });

  it("refuses tampered, expired and selection tokens with 401, without asking", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => contextResponse());
    const client = makeClient(fetchImpl as typeof fetch);

    const tampered = `${sessionToken()}x`;
    await expect(client.verifyRequest(reqWith(tampered))).rejects.toMatchObject({ status: 401 });

    const expired = jwt.sign(
      { personId: "p-1", schoolId: "school-a", email: "a@example.jp" },
      SECRET,
      { algorithm: "HS256", expiresIn: -10 },
    );
    await expect(client.verifyRequest(reqWith(expired))).rejects.toMatchObject({ status: 401 });

    const selection = jwt.sign({ personId: "p-1", purpose: "school-selection" }, SECRET, {
      algorithm: "HS256",
      expiresIn: "10m",
    });
    await expect(client.verifyRequest(reqWith(selection))).rejects.toMatchObject({ status: 401 });

    await expect(client.verifyRequest(reqWith(null))).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it("passes the platform's 401 and 403 through, and does not cache failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: "権限がありません" }), { status: 403 }),
    );
    const client = makeClient(fetchImpl as typeof fetch);
    const req = reqWith(sessionToken());
    const first = await client.verifyRequest(req).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(AuthAccessError);
    expect(first).toMatchObject({ status: 403 });
    await expect(client.verifyRequest(req)).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl.mock.calls.length).toBe(2);
  });

  it("treats a platform failure as an error, not as an auth verdict", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("oops", { status: 500 }));
    const client = makeClient(fetchImpl as typeof fetch);
    const error = await client.verifyRequest(reqWith(sessionToken())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthAccessError);
  });
});
