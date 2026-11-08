import { describe, expect, it } from "vitest";
import {
  AuthAccessError,
  createPlatformClient,
  type PlatformClientOptions,
  type RequestLike,
} from "../src/index.js";

const BASE = "http://platform.test";

// The products never verify the token themselves (the platform holds
// the secret), so the tokens here are opaque strings and the fake
// platform below plays the platform's part: it decides 401 / 403 /
// 200 from the token it was handed.
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

function fakePlatform(): { fetchImpl: typeof fetch; calls: { url: string }[] } {
  const calls: { url: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url) });
    const cookie = (init?.headers as Record<string, string> | undefined)?.cookie ?? "";
    const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
    if (token.startsWith("bad-")) {
      return new Response(JSON.stringify({ error: "認証が必要です" }), { status: 401 });
    }
    if (token.startsWith("stopped-")) {
      return new Response(JSON.stringify({ error: "権限がありません" }), { status: 403 });
    }
    if (token === "broken") return new Response("oops", { status: 500 });
    return contextResponse();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<PlatformClientOptions> = {}) {
  return createPlatformClient({
    platformBaseUrl: BASE,
    product: "schedule",
    fetchImpl,
    ...extra,
  });
}

describe("verifyRequest", () => {
  it("returns the AuthContext the platform answers for a token", async () => {
    const { fetchImpl, calls } = fakePlatform();
    const client = makeClient(fetchImpl);
    const context = await client.verifyRequest(reqWith("good-1"));
    expect(context).toEqual({
      userId: "p-1",
      schoolId: "school-a",
      role: "Editor",
      isSuperAdmin: false,
      personId: null,
      teacherId: "t-1",
    });
    expect(calls[0]?.url).toBe(`${BASE}/platform/api/v1/auth/context?product=schedule`);
  });

  it("caches a successful lookup for the TTL and re-asks after it", async () => {
    let now = 1_000_000;
    const { fetchImpl, calls } = fakePlatform();
    const client = makeClient(fetchImpl, { now: () => now });
    const req = reqWith("good-1");
    await client.verifyRequest(req);
    await client.verifyRequest(req);
    expect(calls.length).toBe(1);
    now += 31_000;
    await client.verifyRequest(req);
    expect(calls.length).toBe(2);
  });

  it("bounds the cache: past the cap the oldest lookup is asked again", async () => {
    const { fetchImpl, calls } = fakePlatform();
    const client = makeClient(fetchImpl, { maxCacheEntries: 2 });
    const reqs = [1, 2, 3].map((n) => reqWith(`good-${n}`));
    for (const req of reqs) await client.verifyRequest(req);
    expect(calls.length).toBe(3);
    // The newest two are still cached; the oldest was evicted.
    await client.verifyRequest(reqs[2] as RequestLike);
    await client.verifyRequest(reqs[1] as RequestLike);
    expect(calls.length).toBe(3);
    await client.verifyRequest(reqs[0] as RequestLike);
    expect(calls.length).toBe(4);
  });

  it("is 401 without a cookie, without asking the platform", async () => {
    const { fetchImpl, calls } = fakePlatform();
    const client = makeClient(fetchImpl);
    await expect(client.verifyRequest(reqWith(null))).rejects.toMatchObject({ status: 401 });
    expect(calls.length).toBe(0);
  });

  it("passes the platform's 401 through (tampered or expired tokens)", async () => {
    const { fetchImpl, calls } = fakePlatform();
    const client = makeClient(fetchImpl);
    const req = reqWith("bad-tampered");
    const first = await client.verifyRequest(req).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(AuthAccessError);
    expect(first).toMatchObject({ status: 401 });
    // Failures are not cached: the platform is asked again.
    await expect(client.verifyRequest(req)).rejects.toMatchObject({ status: 401 });
    expect(calls.length).toBe(2);
  });

  it("passes the platform's 403 through (stopped entitlement, missing role)", async () => {
    const { fetchImpl } = fakePlatform();
    const client = makeClient(fetchImpl);
    const error = await client.verifyRequest(reqWith("stopped-1")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthAccessError);
    expect(error).toMatchObject({ status: 403 });
  });

  it("treats a platform failure as an error, not as an auth verdict", async () => {
    const { fetchImpl } = fakePlatform();
    const client = makeClient(fetchImpl);
    const error = await client.verifyRequest(reqWith("broken")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthAccessError);
  });
});
