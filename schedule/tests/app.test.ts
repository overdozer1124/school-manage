import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AuthAccessError, type AuthContext } from "@school-manage/platform-client";
import { createApp, type ScheduleAppDeps } from "../src/app.js";
import { PlatformRelayError } from "../src/platformClient.js";

// The HTTP layer of the screens (Issue #34): the action endpoints
// under /{slug}/schedule/api/ and the built screens under
// /{slug}/schedule/. The verdict split of DESIGN-AUTH-TENANCY 4.8
// is checked here at the HTTP boundary: a verify refusal is a 401,
// a permission refusal inside the action is a 403, and the two do
// not blur.
const authContext: AuthContext = {
  userId: "user-1",
  schoolId: "school-1",
  role: "Editor",
  isSuperAdmin: false,
  personId: null,
  teacherId: null,
};

let mode: "ok" | "unauthenticated" | "forbidden" | "boom" | "badInput" = "ok";
let lastRequest: unknown = null;

const deps: ScheduleAppDeps = {
  auth: {
    async verifyRequest() {
      if (mode === "unauthenticated") throw new AuthAccessError(401, "認証が必要です");
      return authContext;
    },
  },
  createActions: () => ({
    getBootstrap: {
      async run(_auth: never, request: never) {
        lastRequest = request;
        if (mode === "forbidden") throw new AuthAccessError(403, "権限がありません");
        if (mode === "boom") {
          throw new Error('relation "secret_table" does not exist: select * from secret_table');
        }
        if (mode === "badInput") {
          z.object({ from: z.string() }).parse({});
        }
        return { school: { id: "school-1", name: "テスト学校" } };
      },
    },
    getRange: {
      async run() {
        return { days: [] };
      },
    },
    // Issue #35: a write action rides the same endpoint pattern.
    createEvent: {
      async run(_auth: never, request: never) {
        lastRequest = request;
        return { record: { id: "ev-1" }, values: [] };
      },
    },
    waiveConflict: {
      async run(_auth: never, request: never) {
        lastRequest = request;
        return { waived: true };
      },
    },
  }),
  // Issue #41: the public viewing actions. Their run takes the
  // request alone — no AuthContext, no cookie — and the token in
  // the body is the whole credential.
  createPublicActions: () => ({
    getPublicBootstrap: {
      async run(request: never) {
        lastRequest = request;
        const token = (request as { token?: unknown }).token;
        if (token === "revoked-token") {
          throw new AuthAccessError(401, "この公開URLは無効化されています");
        }
        if (token !== "good-token") {
          throw new PlatformRelayError({
            status: 404,
            body: { error: "公開URLが見つかりません" },
          });
        }
        return { school: { id: "school-1", name: "テスト学校" } };
      },
    },
    getPublicRange: {
      async run(request: never) {
        lastRequest = request;
        return { days: [] };
      },
    },
  }),
};

describe("schedule HTTP app (Issue #34)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const distDir = mkdtempSync(path.join(tmpdir(), "schedule-client-"));
    writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>行事予定</title>");
    server = await new Promise<Server>((resolve) => {
      const s = createApp({ ...deps, clientDistDir: distDir }).listen(0, () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("answers an action call with the action's result and injects the caller's cookie", async () => {
    mode = "ok";
    const res = await fetch(`${baseUrl}/test-school/schedule/api/getBootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "platform_session=tok" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ school: { id: "school-1", name: "テスト学校" } });
    expect(lastRequest).toEqual({ cookie: "platform_session=tok" });
  });

  it("answers a write action call the same way, cookie injected (Issue #35)", async () => {
    mode = "ok";
    const res = await fetch(`${baseUrl}/test-school/schedule/api/createEvent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "platform_session=tok" },
      body: JSON.stringify({ event: { id: "ev-1", title: "運動会" } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ record: { id: "ev-1" }, values: [] });
    expect(lastRequest).toEqual({
      event: { id: "ev-1", title: "運動会" },
      cookie: "platform_session=tok",
    });
  });

  it("answers 401 when the caller is not signed in", async () => {
    mode = "unauthenticated";
    const res = await fetch(`${baseUrl}/test-school/schedule/api/getBootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "認証が必要です" });
  });

  it("answers 403 when the action refuses for permission", async () => {
    mode = "forbidden";
    const res = await fetch(`${baseUrl}/test-school/schedule/api/getBootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "platform_session=tok" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "権限がありません" });
    mode = "ok";
  });

  it("answers 500 with a fixed message and never leaks the exception's detail", async () => {
    mode = "boom";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/test-school/schedule/api/getBootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "platform_session=tok" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "サーバーでエラーが起きました" });
      expect(text).not.toContain("secret_table");
      // The detail is logged server-side instead.
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      mode = "ok";
    }
  });

  it("answers 400 naming only which input is wrong", async () => {
    mode = "badInput";
    const res = await fetch(`${baseUrl}/test-school/schedule/api/getBootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "platform_session=tok" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe("入力が正しくありません");
    expect(body.issues.map((i) => i.path)).toEqual(["from"]);
    mode = "ok";
  });

  it("routes a duty action (Issue #38) the same way, with the caller's cookie", async () => {
    mode = "ok";
    const res = await fetch(`${baseUrl}/test-school/schedule/api/waiveConflict`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "platform_session=tok" },
      body: JSON.stringify({ assignmentId: "as-1", absenceId: "abs-1", reason: "両立できる" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ waived: true });
    expect(lastRequest).toEqual({
      assignmentId: "as-1",
      absenceId: "abs-1",
      reason: "両立できる",
      cookie: "platform_session=tok",
    });
  });

  it("answers 404 for an action the screens do not have", async () => {
    const res = await fetch(`${baseUrl}/test-school/schedule/api/deleteEverything`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("serves a public action with no caller at all (Issue #41)", async () => {
    // No cookie header, and verifyRequest is never consulted.
    // The path's slug is injected into the request, the way the
    // secure route injects the caller's cookie — the action
    // checks it against the token's school (Issue #41 review).
    mode = "unauthenticated";
    const res = await fetch(`${baseUrl}/test-school/schedule/public/getPublicBootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "good-token" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ school: { id: "school-1", name: "テスト学校" } });
    expect(lastRequest).toEqual({ token: "good-token", slug: "test-school" });
    const range = await fetch(`${baseUrl}/test-school/schedule/public/getPublicRange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "good-token", from: "2027-10-01", to: "2027-10-31" }),
    });
    expect(range.status).toBe(200);
    expect(lastRequest).toEqual({
      token: "good-token",
      from: "2027-10-01",
      to: "2027-10-31",
      slug: "test-school",
    });
    mode = "ok";
  });

  it("rate-limits the public route per source address (Issue #41 review)", async () => {
    // A separate app with a small allowance: three public calls
    // pass, the fourth is a 429, and the secure route — a
    // different surface — is not limited by the public budget.
    const distDir = mkdtempSync(path.join(tmpdir(), "schedule-client-rl-"));
    writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>行事予定</title>");
    const limited = await new Promise<Server>((resolve) => {
      const s = createApp({
        ...deps,
        clientDistDir: distDir,
        publicRateLimit: { maxRequests: 3, windowMs: 60_000 },
      }).listen(0, () => resolve(s));
    });
    try {
      const address = limited.address();
      if (!address || typeof address === "string") throw new Error("no server address");
      const base = `http://127.0.0.1:${address.port}`;
      const call = () =>
        fetch(`${base}/test-school/schedule/public/getPublicBootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "good-token" }),
        });
      for (let i = 0; i < 3; i += 1) {
        expect((await call()).status).toBe(200);
      }
      const refused = await call();
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({
        error: "リクエストの回数が上限を超えました。しばらく待ってから再度お試しください。",
      });
      const secure = await fetch(`${base}/test-school/schedule/api/getBootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "platform_session=tok" },
        body: JSON.stringify({}),
      });
      expect(secure.status).toBe(200);
    } finally {
      limited.close();
    }
  });

  // Builds a second app on its own port, with the given deps
  // laid over the shared ones (the trust-proxy tests below each
  // need their own app, and their own limiter).
  async function startSecondApp(
    extra: Partial<ScheduleAppDeps>,
  ): Promise<{ second: Server; base: string }> {
    const distDir = mkdtempSync(path.join(tmpdir(), "schedule-client-tp-"));
    writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>行事予定</title>");
    const second = await new Promise<Server>((resolve) => {
      const s = createApp({ ...deps, clientDistDir: distDir, ...extra }).listen(0, () =>
        resolve(s),
      );
    });
    const address = second.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    return { second, base: `http://127.0.0.1:${address.port}` };
  }

  it("counts forwarded sources separately when trust proxy is set (Issue #41 re-review)", async () => {
    // With TRUST_PROXY set, req.ip is the forwarded source: two
    // readers behind the one proxy each hold their own allowance
    // of two, and the refusal lands per reader, not across
    // readers — the school newsletter's URL opened by every
    // guardian at once must not spend one shared budget.
    const { second, base } = await startSecondApp({
      trustProxy: "loopback",
      publicRateLimit: { maxRequests: 2, windowMs: 60_000 },
    });
    try {
      const call = (forwardedFor: string) =>
        fetch(`${base}/test-school/schedule/public/getPublicBootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
          body: JSON.stringify({ token: "good-token" }),
        });
      expect((await call("198.51.100.1")).status).toBe(200);
      expect((await call("198.51.100.1")).status).toBe(200);
      // The second reader's allowance is untouched by the first's.
      expect((await call("198.51.100.2")).status).toBe(200);
      expect((await call("198.51.100.2")).status).toBe(200);
      // Each reader's third call is the refused one.
      expect((await call("198.51.100.1")).status).toBe(429);
      expect((await call("198.51.100.2")).status).toBe(429);
    } finally {
      second.close();
    }
  });

  it("counts every forwarded source as one when trust proxy is not set (Issue #41 re-review)", async () => {
    // Without TRUST_PROXY, Express ignores X-Forwarded-For:
    // every call carries the proxy's own address (here, the
    // test's direct peer), so differently-headed calls share the
    // one allowance. This is the behaviour the setting exists to
    // change, pinned so the two configurations cannot drift
    // into each other.
    const { second, base } = await startSecondApp({
      publicRateLimit: { maxRequests: 3, windowMs: 60_000 },
    });
    try {
      const call = (forwardedFor: string) =>
        fetch(`${base}/test-school/schedule/public/getPublicBootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
          body: JSON.stringify({ token: "good-token" }),
        });
      expect((await call("198.51.100.1")).status).toBe(200);
      expect((await call("198.51.100.2")).status).toBe(200);
      expect((await call("198.51.100.3")).status).toBe(200);
      expect((await call("198.51.100.4")).status).toBe(429);
    } finally {
      second.close();
    }
  });

  it("maps the public token verdicts: a revoked token is 401, an unknown one 404", async () => {
    const revoked = await fetch(`${baseUrl}/test-school/schedule/public/getPublicBootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "revoked-token" }),
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: "この公開URLは無効化されています" });
    const unknown = await fetch(`${baseUrl}/test-school/schedule/public/getPublicBootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "no-such-token" }),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "公開URLが見つかりません" });
  });

  it("keeps the two routes' allowlists apart (Issue #41)", async () => {
    // A write action's name on the public route is unknown there.
    const write = await fetch(`${baseUrl}/test-school/schedule/public/createEvent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "good-token" }),
    });
    expect(write.status).toBe(404);
    // And a public name on the secure route is unknown there.
    const pub = await fetch(`${baseUrl}/test-school/schedule/api/getPublicRange`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "platform_session=tok" },
      body: JSON.stringify({ token: "good-token", from: "2027-10-01", to: "2027-10-31" }),
    });
    expect(pub.status).toBe(404);
  });

  it("serves the built screens under /{slug}/schedule/", async () => {
    const res = await fetch(`${baseUrl}/test-school/schedule/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>行事予定</title>");
    const deep = await fetch(`${baseUrl}/test-school/schedule/month`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("<title>行事予定</title>");
  });
});
