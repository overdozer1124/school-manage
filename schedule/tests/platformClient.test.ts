import { describe, expect, it, vi } from "vitest";
import { createPlatformApiClient } from "../src/platformClient.js";

// The platform-calling client (implementation 1) against a fake
// platform: what matters is that the user's cookie travels untouched
// and the platform's answer comes back as-is.
describe("createPlatformApiClient", () => {
  it("forwards the user's cookie as-is and returns status and body", async () => {
    const seen: { url: string; cookie: string | undefined } = { url: "", cookie: undefined };
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      seen.url = String(input);
      seen.cookie = new Headers(init?.headers).get("cookie") ?? undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ changes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    const client = createPlatformApiClient({ baseUrl: "http://platform.test/", fetchImpl });
    const result = await client.getJson(
      "/platform/api/v1/changes?after=3",
      "platform_session=token-1; other=x",
    );
    expect(seen.url).toBe("http://platform.test/platform/api/v1/changes?after=3");
    expect(seen.cookie).toBe("platform_session=token-1; other=x");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changes: [] });
  });

  it("returns a non-JSON answer as a null body with its status", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("not json", { status: 502 })));
    const client = createPlatformApiClient({ baseUrl: "http://platform.test", fetchImpl });
    const result = await client.getJson("/platform/api/v1/changes", "platform_session=t");
    expect(result).toEqual({ status: 502, body: null });
  });

  it("sends a write's method, JSON body and cookie, and returns the verdict as-is", async () => {
    const seen: {
      method: string | undefined;
      body: string | undefined;
      cookie: string | undefined;
    } = { method: undefined, body: undefined, cookie: undefined };
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      seen.method = init?.method;
      seen.body = typeof init?.body === "string" ? init.body : undefined;
      seen.cookie = new Headers(init?.headers).get("cookie") ?? undefined;
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: "ほかの人が先に変更しました", latest: { revision: 3 } }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    });
    const client = createPlatformApiClient({ baseUrl: "http://platform.test", fetchImpl });
    const result = await client.requestJson(
      "PUT",
      "/platform/api/v1/calendar/events/ev-1",
      "platform_session=token-2",
      { id: "ev-1", revision: 2, title: "運動会" },
    );
    expect(seen.method).toBe("PUT");
    expect(seen.cookie).toBe("platform_session=token-2");
    expect(JSON.parse(seen.body as string)).toEqual({ id: "ev-1", revision: 2, title: "運動会" });
    // A 409 is the platform's verdict, returned — not thrown — so the
    // relay can pass it on untouched (Issue #29).
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: "ほかの人が先に変更しました",
      latest: { revision: 3 },
    });
  });

  it("sends a revision body with DELETE and reads a 204 as a null body", async () => {
    const seen: { method: string | undefined; body: string | undefined } = {
      method: undefined,
      body: undefined,
    };
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      seen.method = init?.method;
      seen.body = typeof init?.body === "string" ? init.body : undefined;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const client = createPlatformApiClient({ baseUrl: "http://platform.test", fetchImpl });
    const result = await client.requestJson(
      "DELETE",
      "/platform/api/v1/calendar/events/ev-1",
      "platform_session=token-3",
      { revision: 2 },
    );
    expect(seen.method).toBe("DELETE");
    expect(JSON.parse(seen.body as string)).toEqual({ revision: 2 });
    expect(result).toEqual({ status: 204, body: null });
  });
});
