import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// The login screens' delivery (Issue #129): the platform server
// serves the built platform/client under /login, like the schedule
// server serves its screens. No database is involved — a fixture
// directory stands in for the build output.
const INDEX_HTML = '<!doctype html><html lang="ja"><body>ログイン画面</body></html>\n';
const APP_JS = "console.log('login');\n";

let fixtureDir: string;
let server: Server;
let baseUrl: string;
let bareServer: Server;
let bareBaseUrl: string;

async function listen(
  app: ReturnType<typeof createApp>,
): Promise<{ server: Server; baseUrl: string }> {
  const s = app.listen(0);
  await new Promise<void>((resolve) => s.once("listening", resolve));
  const address = s.address();
  if (!address || typeof address === "string") throw new Error("server has no port");
  return { server: s, baseUrl: `http://127.0.0.1:${address.port}` };
}

beforeAll(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "login-client-"));
  writeFileSync(path.join(fixtureDir, "index.html"), INDEX_HTML);
  mkdirSync(path.join(fixtureDir, "assets"));
  writeFileSync(path.join(fixtureDir, "assets", "app.js"), APP_JS);

  ({ server, baseUrl } = await listen(createApp({ loginClientDistDir: fixtureDir })));
  // An app whose build output does not exist (a checkout that never
  // built the client) leaves /login unserved.
  ({ server: bareServer, baseUrl: bareBaseUrl } = await listen(
    createApp({ loginClientDistDir: path.join(fixtureDir, "missing") }),
  ));
});

afterAll(async () => {
  for (const s of [server, bareServer]) {
    await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  }
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("the login screens under /login", () => {
  it("serves the entry page at /login, query string included", async () => {
    // The Google callback returns to /login?code=…&state=…; the
    // page itself must answer there, not a redirect.
    for (const url of [`${baseUrl}/login`, `${baseUrl}/login?code=fake&state=fake`]) {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
    }
  });

  it("serves the built assets beside the entry page", async () => {
    const res = await fetch(`${baseUrl}/login/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(APP_JS);
  });

  it("answers an unknown path under /login with the entry page", async () => {
    const res = await fetch(`${baseUrl}/login/anything/at/all`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("leaves /login unserved when the build output does not exist", async () => {
    const res = await fetch(`${bareBaseUrl}/login`);
    expect(res.status).toBe(404);
  });
});
