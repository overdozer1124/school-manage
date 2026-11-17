import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthAccessError, type AuthContext, type Role } from "@school-manage/platform-client";
import { createScheduleActions } from "../src/composition.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPlatformApiClient, PlatformRelayError } from "../src/platformClient.js";

// Absence-subdivision relay tests (Issue #84): the definitions
// live in the platform, which exposes the full CRUD plus
// apply-defaults (Issue #25) and judges every call itself — but
// the relay is the Admin's alone (school.admin, checked on this
// server before any platform call), and the platform's one
// shared 409 sentence is translated here into the specific
// reason: a classification an absence still uses cannot be
// deleted, and a key may exist only once per kind. The fake
// platform mirrors the real one's answers, including the 409
// shapes: a revision conflict carries the current record as
// `latest`, a duplicate or still-used refusal does not — and
// since Issue #91 the bare refusals name their reason in a
// `code` (duplicate / in_use / key_in_use), which the relay's
// translation follows.
const url = process.env.SCHEDULE_DATABASE_URL;

const COOKIE = "platform_session=test-token";
const SUBDIVISIONS = "/platform/api/v1/calendar/absence-subdivisions";
const CONFLICT = "その操作は現在の状態と競合します";
/** The platform's defaults with their apply-defaults sorts
 *  (Issue #91), in the platform's definition order. */
const DEFAULTS: [string, string, number][] = [
  ["annual", "年休", 10],
  ["sick", "病休", 40],
  ["special", "特休", 20],
  ["summer_special", "夏特", 30],
  ["nursing", "看護", 50],
  ["duty_exempt", "職専免", 70],
  ["compensatory", "振休", 60],
  ["other", "その他", 80],
];

function auth(role: Role): AuthContext {
  return {
    userId: "user-1",
    schoolId: "school-84",
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakePlatform {
  subdivisions = new Map<string, Record<string, unknown>>();
  /** The (code, key) pairs an absence still names. */
  used = new Set<string>();
  calls: { method: string; path: string }[] = [];

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace("http://platform.test", "");
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.calls.push({ method, path });
    return Promise.resolve(this.route(method, path, body));
  };

  private duplicateOf(record: Record<string, unknown>, exceptId?: string): boolean {
    return [...this.subdivisions.values()].some(
      (row) =>
        row["id"] !== exceptId &&
        (row["id"] === record["id"] ||
          (row["code"] === record["code"] && row["key"] === record["key"])),
    );
  }

  private route(method: string, path: string, body: Record<string, unknown> | null): Response {
    if (path === SUBDIVISIONS && method === "GET") {
      const items = [...this.subdivisions.values()].sort((a, b) =>
        a["code"] === b["code"]
          ? Number(a["sort"] ?? 0) - Number(b["sort"] ?? 0) ||
            String(a["key"]).localeCompare(String(b["key"]))
          : String(a["code"]).localeCompare(String(b["code"])),
      );
      return jsonResponse(200, { items });
    }
    if (path === `${SUBDIVISIONS}/apply-defaults` && method === "POST") {
      const created: Record<string, unknown>[] = [];
      for (const [key, label, sort] of DEFAULTS) {
        if (
          [...this.subdivisions.values()].some((r) => r["code"] === "leave" && r["key"] === key)
        ) {
          continue;
        }
        const record = {
          id: `default-leave-${key}`,
          code: "leave",
          key,
          label,
          sort,
          revision: 1,
        };
        this.subdivisions.set(record.id, record);
        created.push(record);
      }
      return jsonResponse(201, { items: created });
    }
    if (path === SUBDIVISIONS && method === "POST") {
      const record = { ...(body ?? {}) };
      if (this.duplicateOf(record)) {
        return jsonResponse(409, { error: CONFLICT, code: "duplicate" });
      }
      // A create that names no sort is appended after its kind,
      // as on the platform.
      if (typeof record["sort"] !== "number") {
        record["sort"] =
          [...this.subdivisions.values()]
            .filter((r) => r["code"] === record["code"])
            .reduce((max, r) => Math.max(max, Number(r["sort"] ?? 0)), 0) + 10;
      }
      const created: Record<string, unknown> = { ...record, revision: 1 };
      this.subdivisions.set(String(created["id"]), created);
      return jsonResponse(201, created);
    }
    const one = new RegExp(`^${SUBDIVISIONS}/([^/]+)$`).exec(path);
    if (one) {
      const existing = this.subdivisions.get(one[1] as string);
      if (!existing) return jsonResponse(404, { error: "見つかりません" });
      if (method === "PUT") {
        if (body?.["revision"] !== existing["revision"]) {
          return jsonResponse(409, { error: "ほかの人が先に変更しました", latest: existing });
        }
        // Moving the key of a classification an absence still
        // names is refused by the foreign key, as on the
        // platform, and the 409 names it (Issue #91).
        if (
          (body?.["key"] !== existing["key"] || body?.["code"] !== existing["code"]) &&
          this.used.has(`${String(existing["code"])}/${String(existing["key"])}`)
        ) {
          return jsonResponse(409, { error: CONFLICT, code: "key_in_use" });
        }
        if (this.duplicateOf(body ?? {}, one[1] as string)) {
          return jsonResponse(409, { error: CONFLICT, code: "duplicate" });
        }
        const updated = { ...(body ?? {}), revision: (existing["revision"] as number) + 1 };
        this.subdivisions.set(one[1] as string, updated);
        return jsonResponse(200, updated);
      }
      if (method === "DELETE") {
        if (body?.["revision"] !== existing["revision"]) {
          return jsonResponse(409, { error: "ほかの人が先に変更しました", latest: existing });
        }
        if (this.used.has(`${String(existing["code"])}/${String(existing["key"])}`)) {
          return jsonResponse(409, { error: CONFLICT, code: "in_use" });
        }
        this.subdivisions.delete(one[1] as string);
        return new Response(null, { status: 204 });
      }
    }
    return jsonResponse(404, { error: "見つかりません" });
  }
}

describe.skipIf(!url)("absence subdivision relay (Issue #84)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let fake: FakePlatform;
  let actions: ReturnType<typeof createScheduleActions>;

  beforeAll(async () => {
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.end();

    const created = createDb(url);
    const db: Db = created.db;
    queryClient = created.queryClient;
    await runMigrations(db);
    fake = new FakePlatform();
    const client = createPlatformApiClient({
      baseUrl: "http://platform.test",
      fetchImpl: fake.fetch,
    });
    actions = createScheduleActions(db, client, COOKIE);
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("an Admin creates, edits and deletes a classification through the relay", async () => {
    const created = (await actions.createSubdivision.run(auth("Admin"), {
      cookie: COOKIE,
      record: { id: "subdiv-care", code: "leave", key: "care", label: "介護休暇" },
    })) as Record<string, unknown>;
    expect(created["revision"]).toBe(1);
    expect(fake.calls.some((c) => c.method === "POST" && c.path === SUBDIVISIONS)).toBe(true);

    const listed = (await actions.getSubdivisions.run(auth("Admin"), {
      cookie: COOKIE,
    })) as { items: Record<string, unknown>[] };
    expect(listed.items.map((i) => i["key"])).toEqual(["care"]);

    const updated = (await actions.updateSubdivision.run(auth("Admin"), {
      cookie: COOKIE,
      id: "subdiv-care",
      record: {
        id: "subdiv-care",
        code: "leave",
        key: "care",
        label: "介護休暇（家族）",
        revision: 1,
      },
    })) as Record<string, unknown>;
    expect(updated["label"]).toBe("介護休暇（家族）");
    expect(updated["revision"]).toBe(2);

    await actions.deleteSubdivision.run(auth("Admin"), {
      cookie: COOKIE,
      id: "subdiv-care",
      revision: 2,
    });
    const after = (await actions.getSubdivisions.run(auth("Admin"), {
      cookie: COOKIE,
    })) as { items: Record<string, unknown>[] };
    expect(after.items).toEqual([]);
  });

  it("apply-defaults seeds the platform's default leave classifications", async () => {
    const seeded = (await actions.applyDefaultSubdivisions.run(auth("Admin"), {
      cookie: COOKIE,
    })) as { items: Record<string, unknown>[] };
    expect(seeded.items.map((i) => i["key"])).toEqual(DEFAULTS.map(([key]) => key));

    const again = (await actions.applyDefaultSubdivisions.run(auth("Admin"), {
      cookie: COOKIE,
    })) as { items: Record<string, unknown>[] };
    expect(again.items).toEqual([]);

    const listed = (await actions.getSubdivisions.run(auth("Admin"), {
      cookie: COOKIE,
    })) as { items: Record<string, unknown>[] };
    expect(listed.items).toHaveLength(8);
  });

  it("a non-Admin is refused by the relay itself, before any platform call", async () => {
    const callsBefore = fake.calls.length;
    for (const role of ["Editor", "Viewer"] as const) {
      await expect(
        actions.getSubdivisions.run(auth(role), { cookie: COOKIE }),
      ).rejects.toBeInstanceOf(AuthAccessError);
      await expect(
        actions.createSubdivision.run(auth(role), {
          cookie: COOKIE,
          record: { id: "subdiv-x", code: "leave", key: "x", label: "仮" },
        }),
      ).rejects.toBeInstanceOf(AuthAccessError);
      await expect(
        actions.updateSubdivision.run(auth(role), {
          cookie: COOKIE,
          id: "default-leave-annual",
          record: {
            id: "default-leave-annual",
            code: "leave",
            key: "annual",
            label: "年休",
            revision: 1,
          },
        }),
      ).rejects.toBeInstanceOf(AuthAccessError);
      await expect(
        actions.deleteSubdivision.run(auth(role), {
          cookie: COOKIE,
          id: "default-leave-annual",
          revision: 1,
        }),
      ).rejects.toBeInstanceOf(AuthAccessError);
      await expect(
        actions.applyDefaultSubdivisions.run(auth(role), { cookie: COOKIE }),
      ).rejects.toBeInstanceOf(AuthAccessError);
    }
    expect(fake.calls).toHaveLength(callsBefore);
  });

  it("deleting a classification an absence still uses stops with the reason, not the raw conflict", async () => {
    fake.used.add("leave/annual");
    const error = await actions.deleteSubdivision
      .run(auth("Admin"), { cookie: COOKIE, id: "default-leave-annual", revision: 1 })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect((error as PlatformRelayError).status).toBe(409);
    expect((error as PlatformRelayError).body).toEqual({
      error: "この分類は不在で使われているため削除できません",
    });
    // Nothing was deleted.
    const listed = (await actions.getSubdivisions.run(auth("Admin"), {
      cookie: COOKIE,
    })) as { items: Record<string, unknown>[] };
    expect(listed.items.map((i) => i["key"])).toContain("annual");
  });

  it("a duplicate key is refused with its reason, and a stale revision keeps the platform's 409", async () => {
    const duplicate = await actions.createSubdivision
      .run(auth("Admin"), {
        cookie: COOKIE,
        record: { id: "subdiv-annual-2", code: "leave", key: "annual", label: "年次休暇" },
      })
      .catch((cause: unknown) => cause);
    expect(duplicate).toBeInstanceOf(PlatformRelayError);
    expect((duplicate as PlatformRelayError).body).toEqual({
      error: "同じ種類で同じキーの分類がすでにあります",
    });

    // A revision conflict carries the current record and passes
    // through untouched — it is not the still-used refusal.
    const stale = await actions.updateSubdivision
      .run(auth("Admin"), {
        cookie: COOKIE,
        id: "default-leave-annual",
        record: {
          id: "default-leave-annual",
          code: "leave",
          key: "annual",
          label: "年休",
          revision: 99,
        },
      })
      .catch((cause: unknown) => cause);
    expect(stale).toBeInstanceOf(PlatformRelayError);
    expect((stale as PlatformRelayError).status).toBe(409);
    expect((stale as PlatformRelayError).body).toMatchObject({
      error: "ほかの人が先に変更しました",
      latest: { id: "default-leave-annual" },
    });
  });

  it("carries the sort through the relay, and the list follows it (Issue #91)", async () => {
    // Two training classifications whose key order and sort
    // order disagree: the list takes the sort.
    await actions.createSubdivision.run(auth("Admin"), {
      cookie: COOKIE,
      record: { id: "subdiv-t-zz", code: "training", key: "zz", label: "研修Z", sort: 10 },
    });
    await actions.createSubdivision.run(auth("Admin"), {
      cookie: COOKIE,
      record: { id: "subdiv-t-aa", code: "training", key: "aa", label: "研修A", sort: 20 },
    });
    const trainingKeys = async () => {
      const listed = (await actions.getSubdivisions.run(auth("Admin"), {
        cookie: COOKIE,
      })) as { items: Record<string, unknown>[] };
      return listed.items.filter((i) => i["code"] === "training").map((i) => i["key"]);
    };
    expect(await trainingKeys()).toEqual(["zz", "aa"]);

    const moved = (await actions.updateSubdivision.run(auth("Admin"), {
      cookie: COOKIE,
      id: "subdiv-t-zz",
      record: {
        id: "subdiv-t-zz",
        code: "training",
        key: "zz",
        label: "研修Z",
        sort: 30,
        revision: 1,
      },
    })) as Record<string, unknown>;
    expect(moved["sort"]).toBe(30);
    expect(await trainingKeys()).toEqual(["aa", "zz"]);
  });

  it("a key change on a used classification stops with its own reason (Issue #91)", async () => {
    // leave/annual is still named by an absence (the delete
    // test above marked it used, and it was never deleted).
    const error = await actions.updateSubdivision
      .run(auth("Admin"), {
        cookie: COOKIE,
        id: "default-leave-annual",
        record: {
          id: "default-leave-annual",
          code: "leave",
          key: "nenkyu",
          label: "年休",
          sort: 10,
          revision: 1,
        },
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect((error as PlatformRelayError).status).toBe(409);
    expect((error as PlatformRelayError).body).toEqual({
      error: "この分類は不在で使われているためキーは変更できません",
    });

    // Nothing was renamed.
    const listed = (await actions.getSubdivisions.run(auth("Admin"), {
      cookie: COOKIE,
    })) as { items: Record<string, unknown>[] };
    expect(listed.items.map((i) => i["key"])).toContain("annual");
    expect(listed.items.map((i) => i["key"])).not.toContain("nenkyu");
  });
});
