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
});
