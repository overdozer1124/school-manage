import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChangeStore, RevisionConflictError, type ChangeStore } from "../src/db/changes.js";
import { createDb, type Db } from "../src/db/client.js";
import { createEventStore, type EventStore } from "../src/db/events.js";
import { createMasterStore, type MasterStore } from "../src/db/masters.js";
import { runMigrations } from "../src/db/migrate.js";
import { eventAssignees, eventImpacts, persons, schools } from "../src/db/schema.js";

// Revisioned-delete race tests (Issue #59): a delete that checked
// the revision and then deleted without it used to erase an update
// committed in between. Each test holds a real UPDATE open on one
// connection, starts the delete (with the now-stale revision) from a
// second connection's store, and only then lets the update commit:
// the delete must wait, then refuse with 409, and the row and the
// update must survive. Runs only when PLATFORM_DATABASE_URL is set.
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const actor = { userId: "person-1", via: "platform" } as const;

describe.skipIf(!url)("revisioned delete race", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let masterStore: MasterStore;
  let eventStore: EventStore;
  let changeStore: ChangeStore;

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

    await db.insert(schools).values([{ schoolId: A, slug: "school-a", name: "A校" }]);
    await db
      .insert(persons)
      .values([{ id: "person-1", email: "person1@example.jp", displayName: "教員1" }]);

    masterStore = createMasterStore(db);
    eventStore = createEventStore(db);
    changeStore = createChangeStore(db);
  });

  afterAll(async () => {
    await queryClient.end();
  });

  /**
   * Runs `updateSql` in an open transaction on its own connection
   * and returns handles to observe and release it. `locked` flips
   * only after the UPDATE statement has completed inside the
   * transaction, which is what guarantees the row lock is held
   * before the delete below is started (the ordering the Issue
   * asks the test to make certain).
   */
  async function holdUpdate(updateSql: string, lockCheckSql: string) {
    const updater = postgres(url as string, { max: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = false;
    const txPromise = updater.begin(async (tx) => {
      await tx.unsafe(updateSql);
      locked = true;
      await gate;
    });
    for (let i = 0; i < 250 && !locked; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(locked).toBe(true);
    // Belt and braces: a third connection cannot lock the same row
    // right now, which proves the updater's lock is really held
    // (not merely that its UPDATE statement has run).
    const probe = postgres(url as string, { max: 1 });
    await expect(
      probe.begin(async (tx) => {
        await tx.unsafe("set local lock_timeout = '200ms'");
        await tx.unsafe(lockCheckSql);
      }),
    ).rejects.toThrow();
    await probe.end();
    return {
      async commit() {
        release();
        await txPromise;
        await updater.end();
      },
    };
  }

  /** Starts a remove and tracks whether it has settled yet. */
  function startRemove(remove: () => Promise<void>) {
    let settled = false;
    let error: unknown;
    const promise = remove().then(
      () => {
        settled = true;
      },
      (e: unknown) => {
        settled = true;
        error = e;
      },
    );
    return {
      get settled() {
        return settled;
      },
      get error() {
        return error;
      },
      promise,
    };
  }

  async function expectBlockedThenConflict(
    held: { commit(): Promise<void> },
    remove: ReturnType<typeof startRemove>,
  ) {
    // The delete must be waiting on the updater's row lock, not
    // sailing through with the stale revision.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(remove.settled).toBe(false);
    await held.commit();
    await remove.promise;
    expect(remove.settled).toBe(true);
    expect(remove.error).toBeInstanceOf(RevisionConflictError);
    return remove.error as RevisionConflictError;
  }

  async function deleteEventsFor(entityId: string) {
    return (await changeStore.listChanges(A, 0, 500)).filter(
      (c) => c.entityId === entityId && c.op === "delete",
    );
  }

  it("does not erase a concurrent update when deleting a staff member (common CRUD)", async () => {
    await masterStore.staff.create(
      {
        schoolId: A,
        id: "staff-race",
        name: "競合先生",
        shortName: "競合",
        sortOrder: 1,
        active: true,
        personId: null,
      },
      actor,
    );
    const remover = createDb(url as string);
    try {
      const held = await holdUpdate(
        `update staff_members set revision = 2, name = '更新後の先生'
         where school_id = '${A}' and id = 'staff-race'`,
        `select 1 from staff_members where school_id = '${A}' and id = 'staff-race' for update`,
      );
      const remove = startRemove(() =>
        createMasterStore(remover.db).staff.remove(A, "staff-race", 1, actor),
      );
      const error = await expectBlockedThenConflict(held, remove);
      expect(error.status).toBe(409);
      expect(error.latest).toMatchObject({ revision: 2, name: "更新後の先生" });

      // The row and the update survive; no delete was recorded.
      expect(await masterStore.staff.get(A, "staff-race")).toMatchObject({
        revision: 2,
        name: "更新後の先生",
      });
      expect(await deleteEventsFor("staff-race")).toEqual([]);

      // Deleting at the revision the row actually stands at works,
      // and the outbox delete carries that revision + 1.
      await masterStore.staff.remove(A, "staff-race", 2, actor);
      expect(await masterStore.staff.get(A, "staff-race")).toBeUndefined();
      expect((await deleteEventsFor("staff-race")).map((c) => c.revision)).toEqual([3]);
    } finally {
      await remover.queryClient.end();
    }
  });

  it("does not erase a concurrent update when deleting a day pattern", async () => {
    await masterStore.dayPatterns.create(
      {
        schoolId: A,
        id: "pattern-race",
        code: "R",
        name: "競合日課",
        kind: "normal",
        periods: [
          { period: 1, label: "1限", startsAt: "08:50", endsAt: "09:40" },
          { period: 2, label: "2限", startsAt: "09:50", endsAt: "10:40" },
        ],
      },
      actor,
    );
    const remover = createDb(url as string);
    try {
      const held = await holdUpdate(
        `update day_patterns set revision = 2, name = '更新後の日課'
         where school_id = '${A}' and id = 'pattern-race'`,
        `select 1 from day_patterns where school_id = '${A}' and id = 'pattern-race' for update`,
      );
      const remove = startRemove(() =>
        createMasterStore(remover.db).dayPatterns.remove(A, "pattern-race", 1, actor),
      );
      const error = await expectBlockedThenConflict(held, remove);
      expect(error.status).toBe(409);
      expect(error.latest).toMatchObject({ revision: 2, name: "更新後の日課" });
      expect((error.latest as { periods: unknown[] }).periods).toHaveLength(2);

      // The pattern, its update and its periods survive.
      const surviving = await masterStore.dayPatterns.get(A, "pattern-race");
      expect(surviving).toMatchObject({ revision: 2, name: "更新後の日課" });
      expect(surviving?.periods).toHaveLength(2);
      expect(await deleteEventsFor("pattern-race")).toEqual([]);

      await masterStore.dayPatterns.remove(A, "pattern-race", 2, actor);
      expect(await masterStore.dayPatterns.get(A, "pattern-race")).toBeUndefined();
      expect((await deleteEventsFor("pattern-race")).map((c) => c.revision)).toEqual([3]);
    } finally {
      await remover.queryClient.end();
    }
  });

  it("does not erase a concurrent update when deleting an event", async () => {
    await eventStore.create(
      {
        schoolId: A,
        id: "ev-race",
        title: "競合行事",
        kind: "event",
        kindLabel: null,
        datePrecision: "day",
        startsOn: "2026-11-10",
        endsOn: null,
        time: { kind: "all_day" },
        locationId: null,
        locationText: null,
        description: null,
        certainty: "tentative",
        visibility: "public",
        targets: [],
        impacts: [{ kind: "room_use", roomId: "gym", time: { kind: "all_day" } }],
        assignees: [{ kind: "free_text", name: "外部講師", role: null }],
      },
      actor,
    );
    const remover = createDb(url as string);
    try {
      const held = await holdUpdate(
        `update events set revision = 2, title = '更新後の行事'
         where school_id = '${A}' and id = 'ev-race'`,
        `select 1 from events where school_id = '${A}' and id = 'ev-race' for update`,
      );
      const remove = startRemove(() => createEventStore(remover.db).remove(A, "ev-race", 1, actor));
      const error = await expectBlockedThenConflict(held, remove);
      expect(error.status).toBe(409);
      // The 409 body stays privacy-filtered, as with updates.
      expect(error.latest).toMatchObject({ revision: 2, title: "更新後の行事" });
      expect(error.latest).not.toHaveProperty("assignees");
      expect(error.latest).not.toHaveProperty("description");

      // The event, its update and its children survive.
      const surviving = await eventStore.get(A, "ev-race", "staff");
      expect(surviving).toMatchObject({ revision: 2, title: "更新後の行事" });
      expect(surviving?.impacts).toHaveLength(1);
      expect(surviving?.assignees).toHaveLength(1);
      expect(
        (await changeStore.listChanges(A, 0, 500)).filter(
          (c) => c.kind === "event" && c.entityId === "ev-race" && c.op === "delete",
        ),
      ).toEqual([]);

      await eventStore.remove(A, "ev-race", 2, actor);
      expect(await eventStore.get(A, "ev-race", "staff")).toBeUndefined();
      expect(await db.select().from(eventImpacts)).toEqual([]);
      expect(await db.select().from(eventAssignees)).toEqual([]);
      const deletes = (await changeStore.listChanges(A, 0, 500)).filter(
        (c) => c.kind === "event" && c.entityId === "ev-race" && c.op === "delete",
      );
      expect(deletes.map((c) => c.revision)).toEqual([3]);
    } finally {
      await remover.queryClient.end();
    }
  });
});
