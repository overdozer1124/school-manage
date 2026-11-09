import type { Server } from "node:http";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeEventSchema, type ChangeEvent } from "@school-manage/calendar-types";
import { createApp } from "../src/app.js";
import { loadAuthConfig, type AuthConfig } from "../src/auth/config.js";
import { signSessionToken } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import {
  appendChange,
  createChangeStore,
  saveWithChange,
  updateRevisioned,
  RevisionConflictError,
  type ChangeStore,
} from "../src/db/changes.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { memberships, persons, schools } from "../src/db/schema.js";

// Change outbox tests (Issue #21): the save helpers against a small
// test table, and the refetch endpoint over HTTP. Runs only when
// PLATFORM_DATABASE_URL is set (see vitest.config.ts).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const B = "school-b";
const SECRET = "changes-test-secret";

/** A stand-in business table with the shared entity meta. */
const testEntities = pgTable("change_test_entities", {
  schoolId: text("school_id").notNull(),
  id: text("id").notNull(),
  revision: integer("revision").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedVia: text("updated_via").notNull(),
  label: text("label").notNull(),
});

const actor = { userId: "person-1", via: "platform" } as const;

describe.skipIf(!url)("change outbox", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let changeStore: ChangeStore;
  let config: AuthConfig;
  let server: Server;
  let baseUrl: string;

  async function createEntity(schoolId: string, id: string, label: string) {
    return saveWithChange(
      db,
      { schoolId, kind: "day_pattern", entityId: id, revision: 1, op: "upsert", actor },
      async (tx) => {
        const rows = await tx
          .insert(testEntities)
          .values({
            schoolId,
            id,
            revision: 1,
            updatedBy: actor.userId,
            updatedVia: actor.via,
            label,
          })
          .returning();
        return rows[0];
      },
    );
  }

  function sessionCookie(personId: string, schoolId: string, email: string): string {
    const token = signSessionToken(config, { personId, schoolId, email });
    return `platform_session=${encodeURIComponent(token)}`;
  }

  async function getChanges(
    path: string,
    cookie?: string,
  ): Promise<{ status: number; json: { changes?: ChangeEvent[]; error?: string } }> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: cookie ? { cookie } : {},
    });
    const json = (await res.json().catch(() => null)) as {
      changes?: ChangeEvent[];
      error?: string;
    };
    return { status: res.status, json };
  }

  beforeAll(async () => {
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.end();

    const created = createDb(url);
    db = created.db;
    queryClient = created.queryClient;
    await runMigrations(db);
    await runMigrations(db);

    // The test table is not part of the platform schema; the helpers
    // are what is under test, against any revisioned table.
    const ddl = postgres(url as string, { max: 1 });
    await ddl.unsafe(`create table change_test_entities (
      school_id text not null,
      id text not null,
      revision integer not null,
      updated_by text not null,
      updated_via text not null,
      label text not null,
      primary key (school_id, id)
    )`);
    await ddl.end();

    await db.insert(schools).values([
      { schoolId: A, slug: "school-a", name: "A校" },
      { schoolId: B, slug: "school-b", name: "B校" },
    ]);
    await db.insert(persons).values([
      { id: "person-1", email: "person1@example.jp", displayName: "教員1" },
      { id: "person-2", email: "person2@example.jp", displayName: "教員2" },
    ]);
    // person-1 belongs to both schools; person-2 to B only.
    await db.insert(memberships).values([
      { id: "membership-a1", schoolId: A, personId: "person-1", status: "approved" },
      { id: "membership-b1", schoolId: B, personId: "person-1", status: "approved" },
      { id: "membership-b2", schoolId: B, personId: "person-2", status: "approved" },
    ]);

    changeStore = createChangeStore(db);
    config = loadAuthConfig({ JWT_SECRET: SECRET });
    const app = createApp({
      changes: { config, authStore: createAuthStore(db), changeStore },
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.close();
    await queryClient.end();
  });

  it("records the entity write and its change event in one transaction", async () => {
    const row = await createEntity(A, "entity-1", "通常日課");
    expect(row?.label).toBe("通常日課");
    const changes = await changeStore.listChanges(A, 0, 10);
    expect(changes).toHaveLength(1);
    const event = changeEventSchema.parse(changes[0]);
    expect(event.seq).toBeGreaterThanOrEqual(1);
    expect(event).toMatchObject({
      schoolId: A,
      kind: "day_pattern",
      entityId: "entity-1",
      revision: 1,
      op: "upsert",
      actor: { userId: "person-1", via: "platform" },
    });
  });

  it("leaves neither the row nor the event behind when the write fails", async () => {
    const before = await changeStore.listChanges(A, 0, 100);
    await expect(
      saveWithChange(
        db,
        {
          schoolId: A,
          kind: "day_pattern",
          entityId: "entity-fail",
          revision: 1,
          op: "upsert",
          actor,
        },
        async (tx) => {
          await tx.insert(testEntities).values({
            schoolId: A,
            id: "entity-fail",
            revision: 1,
            updatedBy: actor.userId,
            updatedVia: actor.via,
            label: "消える行",
          });
          throw new Error("simulated failure after the insert");
        },
      ),
    ).rejects.toThrow("simulated failure");
    const rows = await db.select().from(testEntities);
    expect(rows.map((r) => r.id)).not.toContain("entity-fail");
    expect(await changeStore.listChanges(A, 0, 100)).toHaveLength(before.length);
  });

  it("updates under the optimistic lock, stamping revision and writer", async () => {
    const updated = await db.transaction((tx) =>
      updateRevisioned(tx, testEntities, {
        schoolId: A,
        id: "entity-1",
        expectedRevision: 1,
        actor: { userId: "person-2", via: "schedule" },
        set: { label: "短縮日課" },
      }),
    );
    expect(updated.revision).toBe(2);
    expect(updated.label).toBe("短縮日課");
    expect(updated.updatedBy).toBe("person-2");
    expect(updated.updatedVia).toBe("schedule");
  });

  it("refuses a stale revision and attaches the latest content", async () => {
    const attempt = db.transaction((tx) =>
      updateRevisioned(tx, testEntities, {
        schoolId: A,
        id: "entity-1",
        expectedRevision: 1,
        actor,
        set: { label: "古い版での保存" },
      }),
    );
    await expect(attempt).rejects.toBeInstanceOf(RevisionConflictError);
    const error = await attempt.catch((e: unknown) => e);
    if (!(error instanceof RevisionConflictError)) throw new Error("expected a conflict");
    expect(error.status).toBe(409);
    const latest = error.latest as { label: string; revision: number };
    expect(latest.label).toBe("短縮日課");
    expect(latest.revision).toBe(2);
  });

  it("serves only the session school's changes, in seq order, after a watermark", async () => {
    await createEntity(B, "entity-b1", "B校の日課");
    const cookieA = sessionCookie("person-1", A, "person1@example.jp");

    const all = await getChanges("/platform/api/v1/changes", cookieA);
    expect(all.status).toBe(200);
    const changes = all.json.changes as ChangeEvent[];
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.every((c) => c.schoolId === A)).toBe(true);
    expect(changes.map((c) => c.entityId)).not.toContain("entity-b1");
    const seqs = changes.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    for (const c of changes) changeEventSchema.parse(c);

    const lastSeq = seqs[seqs.length - 1] as number;
    const after = await getChanges(`/platform/api/v1/changes?after=${lastSeq}`, cookieA);
    expect(after.status).toBe(200);
    expect(after.json.changes).toEqual([]);

    const limited = await getChanges("/platform/api/v1/changes?limit=1", cookieA);
    expect(limited.json.changes).toHaveLength(1);
    expect(limited.json.changes?.[0]?.seq).toBe(seqs[0]);
  });

  it("refuses the endpoint without a session and for a non-member school", async () => {
    const anonymous = await getChanges("/platform/api/v1/changes");
    expect(anonymous.status).toBe(401);
    // person-2 belongs to B only; a session naming A must not read A.
    const cookie = sessionCookie("person-2", A, "person2@example.jp");
    const refused = await getChanges("/platform/api/v1/changes", cookie);
    expect(refused.status).toBe(403);
  });

  it("never lets a later change become visible before an earlier one commits", async () => {
    // Two independent connections. While the first transaction still
    // holds its appended change uncommitted, the second save must not
    // complete — otherwise a reader could see the second change
    // alone, move its watermark past the first, and never refetch
    // the first once it commits.
    const first = createDb(url as string);
    const second = createDb(url as string);
    try {
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstAppended = false;
      const txFirst = first.db.transaction(async (tx) => {
        await appendChange(tx, {
          schoolId: A,
          kind: "day_pattern",
          entityId: "entity-lock-first",
          revision: 1,
          op: "upsert",
          actor,
        });
        firstAppended = true;
        await gate;
      });
      for (let i = 0; i < 100 && !firstAppended; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(firstAppended).toBe(true);

      let secondSettled = false;
      const txSecond = saveWithChange(
        second.db,
        {
          schoolId: A,
          kind: "day_pattern",
          entityId: "entity-lock-second",
          revision: 1,
          op: "upsert",
          actor,
        },
        async (tx) => {
          const rows = await tx
            .insert(testEntities)
            .values({
              schoolId: A,
              id: "entity-lock-second",
              revision: 1,
              updatedBy: actor.userId,
              updatedVia: actor.via,
              label: "直列化の確認",
            })
            .returning();
          return rows[0];
        },
      ).then(
        () => {
          secondSettled = true;
        },
        () => {
          secondSettled = true;
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(secondSettled).toBe(false);
      const visible = await changeStore.listChanges(A, 0, 100);
      expect(visible.map((c) => c.entityId)).not.toContain("entity-lock-first");
      expect(visible.map((c) => c.entityId)).not.toContain("entity-lock-second");

      releaseFirst();
      await txFirst;
      await txSecond;
      expect(secondSettled).toBe(true);

      const all = await changeStore.listChanges(A, 0, 100);
      const firstEvent = all.find((c) => c.entityId === "entity-lock-first");
      const secondEvent = all.find((c) => c.entityId === "entity-lock-second");
      expect(firstEvent).toBeDefined();
      expect(secondEvent).toBeDefined();
      expect((firstEvent as ChangeEvent).seq).toBeLessThan((secondEvent as ChangeEvent).seq);
    } finally {
      await first.queryClient.end();
      await second.queryClient.end();
    }
  });

  it("records the revision the write actually produced when change is a function", async () => {
    const updated = await saveWithChange(
      db,
      (row: typeof testEntities.$inferSelect) => ({
        schoolId: A,
        kind: "day_pattern" as const,
        entityId: "entity-1",
        revision: row.revision,
        op: "upsert" as const,
        actor,
      }),
      async (tx) =>
        updateRevisioned(tx, testEntities, {
          schoolId: A,
          id: "entity-1",
          expectedRevision: 2,
          actor,
          set: { label: "版番号は書き込みの結果から" },
        }),
    );
    expect(updated.revision).toBe(3);
    const mine = (await changeStore.listChanges(A, 0, 100)).filter(
      (c) => c.entityId === "entity-1",
    );
    expect(mine[mine.length - 1]?.revision).toBe(3);
  });
});
