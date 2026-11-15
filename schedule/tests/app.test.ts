import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthAccessError, type AuthContext } from "@school-manage/platform-client";
import { createApp, type ScheduleAppDeps } from "../src/app.js";

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

let mode: "ok" | "unauthenticated" | "forbidden" = "ok";
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
        return { school: { id: "school-1", name: "テスト学校" } };
      },
    },
    getRange: {
      async run() {
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

  it("answers 404 for an action the screens do not have", async () => {
    const res = await fetch(`${baseUrl}/test-school/schedule/api/deleteEverything`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
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
