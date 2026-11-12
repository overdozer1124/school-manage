import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthAccessError, type AuthContext, type Role } from "@school-manage/platform-client";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDefinitionActions } from "../src/definitions/actions.js";
import { createDailyValueActions } from "../src/dailyValues/actions.js";

// Daily-value tests (Issue #28): typed values in cells
// (date x item x target x slot), the bulk set for several targets,
// the 4.4 roles (Viewer cannot write) and two-school separation.
// Runs only when SCHEDULE_DATABASE_URL is set (vitest.config.ts
// points it at the test database).
const url = process.env.SCHEDULE_DATABASE_URL;

type Actions = ReturnType<typeof createDailyValueActions>;

function auth(schoolId: string, role: Role, userId = `user-${schoolId}`): AuthContext {
  return {
    userId,
    schoolId,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

const A = "school-a";
const B = "school-b";
const DATE = "2027-04-10";

describe.skipIf(!url)("schedule daily values", () => {
  let queryClient: ReturnType<typeof postgres>;
  let actions: Actions;
  let dbForDefs: Db;

  beforeAll(async () => {
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.end();

    const created = createDb(url);
    const db: Db = created.db;
    dbForDefs = db;
    queryClient = created.queryClient;
    await runMigrations(db);
    actions = createDailyValueActions(db);

    // Fixtures for school A: a no-axis symbol item (lunch), a
    // grade-axis time item (dismissal), an app-axis time item
    // (bus, over the bus_route group), and one item per remaining
    // value type.
    const defs = createDefinitionActions(db);
    const adminA = auth(A, "Admin");
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-lunch",
      key: "lunch",
      name: "給食",
      valueType: "symbol",
      granularity: "day",
      defaultVisibility: "guardian",
      options: [
        { id: "opt-lunch-yes", code: "yes", label: "○" },
        { id: "opt-lunch-no", code: "no", label: "×" },
      ],
    });
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-dismissal",
      key: "dismissal",
      name: "下校時刻",
      valueType: "time",
      targetPlatformAxis: "grade",
      granularity: "day",
      defaultVisibility: "guardian",
    });
    await defs.upsertTargetGroup.run(adminA, { id: "tg-bus", key: "bus_route", name: "バス便" });
    await defs.upsertTarget.run(adminA, { id: "tgt-bus-1", targetGroupId: "tg-bus", name: "①便" });
    await defs.upsertTarget.run(adminA, { id: "tgt-bus-2", targetGroupId: "tg-bus", name: "②便" });
    await defs.upsertItemDefinition.run(adminA, {
      id: "item-bus",
      key: "bus",
      name: "バス",
      valueType: "time",
      targetGroupId: "tg-bus",
      granularity: "day",
      defaultVisibility: "guardian",
    });
    const plain = [
      ["item-note", "note", "text"],
      ["item-periods", "periods_count", "number"],
      ["item-cleaning", "cleaning", "boolean"],
      ["item-duty", "duty_person", "person"],
    ] as const;
    for (const [id, key, valueType] of plain) {
      await defs.upsertItemDefinition.run(adminA, {
        id,
        key,
        name: key,
        valueType,
        granularity: "day",
        defaultVisibility: "staff_only",
      });
    }
    // School B has its own lunch item with the same key.
    await defs.upsertItemDefinition.run(auth(B, "Admin"), {
      id: "item-lunch-b",
      key: "lunch",
      name: "給食",
      valueType: "symbol",
      granularity: "day",
      defaultVisibility: "guardian",
      options: [{ id: "opt-lunch-b-yes", code: "yes", label: "○" }],
    });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("sets, reads back and overwrites a value; slots are separate cells", async () => {
    const editor = auth(A, "Editor");
    const row = await actions.setDailyValue.run(editor, {
      date: DATE,
      itemDefinitionId: "item-lunch",
      value: "yes",
    });
    expect(row.valueOptionId).toBe("opt-lunch-yes");
    expect(row.targetKey).toBe("");
    expect(row.slot).toBe("all_day");
    expect(row.createdBy).toBe(editor.userId);
    expect(row.updatedBy).toBe(editor.userId);

    const am = await actions.setDailyValue.run(editor, {
      date: DATE,
      itemDefinitionId: "item-lunch",
      slot: "am",
      value: "no",
    });
    expect(am.valueOptionId).toBe("opt-lunch-no");

    const rows = await actions.getDailyValues.run(auth(A, "Viewer"), { from: DATE, to: DATE });
    const lunch = rows.filter((r) => r.itemDefinitionId === "item-lunch");
    expect(lunch.map((r) => r.slot)).toEqual(["all_day", "am"]);

    // Overwriting the same cell replaces the value, keeps the row
    // and its creator, and records the new editor (audit, 4.7).
    const admin = auth(A, "Admin", "admin-a");
    const overwritten = await actions.setDailyValue.run(admin, {
      date: DATE,
      itemDefinitionId: "item-lunch",
      value: "no",
    });
    expect(overwritten.id).toBe(row.id);
    expect(overwritten.valueOptionId).toBe("opt-lunch-no");
    expect(overwritten.createdBy).toBe(editor.userId);
    expect(overwritten.updatedBy).toBe("admin-a");

    // Outside the range nothing comes back.
    const none = await actions.getDailyValues.run(editor, {
      from: "2027-05-01",
      to: "2027-05-31",
    });
    expect(none.filter((r) => r.itemDefinitionId === "item-lunch")).toHaveLength(0);
  });

  it("stores each value type in its own columns", async () => {
    const editor = auth(A, "Editor");
    const time = await actions.setDailyValue.run(editor, {
      date: DATE,
      itemDefinitionId: "item-dismissal",
      target: { axis: "grade", id: "grade-1" },
      value: "14:30",
    });
    expect(time.valueTime).toBe("14:30");
    expect(time.targetRef).toEqual({ axis: "grade", id: "grade-1" });
    expect(time.targetKey).toBe("grade:grade-1");
    expect(time.targetId).toBeNull();

    const bus = await actions.setDailyValue.run(editor, {
      date: DATE,
      itemDefinitionId: "item-bus",
      target: { axis: "app", app: "schedule", axisKey: "bus_route", id: "tgt-bus-1" },
      value: "13:00",
    });
    expect(bus.targetId).toBe("tgt-bus-1");
    expect(bus.targetRef).toBeNull();
    expect(bus.targetKey).toBe("app:tgt-bus-1");

    const number = await actions.setDailyValue.run(editor, {
      date: DATE,
      itemDefinitionId: "item-periods",
      value: 5,
    });
    expect(number.valueNumber).toBe(5);
    const flag = await actions.setDailyValue.run(editor, {
      date: DATE,
      itemDefinitionId: "item-cleaning",
      value: true,
    });
    expect(flag.valueBoolean).toBe(true);
    const person = await actions.setDailyValue.run(editor, {
      date: DATE,
      itemDefinitionId: "item-duty",
      value: "person-9",
    });
    expect(person.valuePersonId).toBe("person-9");
    const note = await actions.setDailyValue.run(editor, {
      date: DATE,
      itemDefinitionId: "item-note",
      value: "雨天時は体育館",
    });
    expect(note.valueText).toBe("雨天時は体育館");
  });

  it("rejects values that do not fit the item's type", async () => {
    const editor = auth(A, "Editor");
    await expect(
      actions.setDailyValue.run(editor, {
        date: DATE,
        itemDefinitionId: "item-lunch",
        value: "maybe",
      }),
    ).rejects.toThrow("unknown symbol code");
    await expect(
      actions.setDailyValue.run(editor, {
        date: DATE,
        itemDefinitionId: "item-dismissal",
        target: { axis: "grade", id: "grade-1" },
        value: "25:00",
      }),
    ).rejects.toThrow("HH:MM");
    await expect(
      actions.setDailyValue.run(editor, {
        date: DATE,
        itemDefinitionId: "item-periods",
        value: "5",
      }),
    ).rejects.toThrow("finite number");
    await expect(
      actions.setDailyValue.run(editor, {
        date: DATE,
        itemDefinitionId: "item-note",
        value: "x",
        slot: 100 as never,
      }),
    ).rejects.toThrow();
  });

  it("rejects targets that do not fit the item's axis", async () => {
    const editor = auth(A, "Editor");
    // The lunch item has no axis.
    await expect(
      actions.setDailyValue.run(editor, {
        date: DATE,
        itemDefinitionId: "item-lunch",
        target: { axis: "grade", id: "grade-1" },
        value: "yes",
      }),
    ).rejects.toThrow("does not vary by target");
    // The dismissal item varies over grades, not bus routes.
    await expect(
      actions.setDailyValue.run(editor, {
        date: DATE,
        itemDefinitionId: "item-dismissal",
        target: { axis: "app", app: "schedule", axisKey: "bus_route", id: "tgt-bus-1" },
        value: "14:30",
      }),
    ).rejects.toThrow("platform axis");
    // The bus item needs a bus target, not a grade.
    await expect(
      actions.setDailyValue.run(editor, {
        date: DATE,
        itemDefinitionId: "item-bus",
        target: { axis: "grade", id: "grade-1" },
        value: "13:00",
      }),
    ).rejects.toThrow("app target group");
    // A bus target named through the wrong axis key is refused.
    await expect(
      actions.setDailyValue.run(editor, {
        date: DATE,
        itemDefinitionId: "item-bus",
        target: { axis: "app", app: "schedule", axisKey: "club", id: "tgt-bus-1" },
        value: "13:00",
      }),
    ).rejects.toThrow("not the item's target group");
  });

  it("requires a target for items that vary by target (set and delete)", async () => {
    // PR #58 review, mandatory 1: an axis-bearing item must not
    // accept a targetless row (DESIGN 4.8.2: values are per
    // target). Both the platform-axis item (dismissal) and the
    // app-axis item (bus) refuse, for setting and for deleting.
    const editor = auth(A, "Editor");
    await expect(
      actions.setDailyValue.run(editor, {
        date: "2027-04-16",
        itemDefinitionId: "item-dismissal",
        value: "14:30",
      }),
    ).rejects.toThrow("target is required");
    await expect(
      actions.setDailyValue.run(editor, {
        date: "2027-04-16",
        itemDefinitionId: "item-bus",
        value: "13:00",
      }),
    ).rejects.toThrow("target is required");
    await expect(
      actions.deleteDailyValue.run(editor, {
        date: "2027-04-16",
        itemDefinitionId: "item-dismissal",
      }),
    ).rejects.toThrow("target is required");
    await expect(
      actions.deleteDailyValue.run(editor, {
        date: "2027-04-16",
        itemDefinitionId: "item-bus",
      }),
    ).rejects.toThrow("target is required");
    // No targetless row was written as a side effect.
    const read = await actions.getDailyValues.run(editor, {
      from: "2027-04-16",
      to: "2027-04-16",
    });
    expect(read).toHaveLength(0);
    // Deleting with the target named still works.
    await actions.setDailyValue.run(editor, {
      date: "2027-04-16",
      itemDefinitionId: "item-dismissal",
      target: { axis: "grade", id: "grade-1" },
      value: "14:30",
    });
    await actions.deleteDailyValue.run(editor, {
      date: "2027-04-16",
      itemDefinitionId: "item-dismissal",
      target: { axis: "grade", id: "grade-1" },
    });
    const after = await actions.getDailyValues.run(editor, {
      from: "2027-04-16",
      to: "2027-04-16",
    });
    expect(after).toHaveLength(0);
  });

  it("refuses definition updates that would strand daily values", async () => {
    // PR #58 review, recommendations 1 and 2: while an item has
    // daily values, its definition update may not drop an in-use
    // option, nor change the value type or the axis.
    const admin = auth(A, "Admin");
    const editor = auth(A, "Editor");
    const defs = createDefinitionActions(dbForDefs);
    await defs.upsertItemDefinition.run(admin, {
      id: "item-rec",
      key: "rec_item",
      name: "推奨テスト項目",
      valueType: "symbol",
      granularity: "day",
      defaultVisibility: "staff_only",
      options: [
        { id: "opt-rec-a", code: "a", label: "A" },
        { id: "opt-rec-b", code: "b", label: "B" },
      ],
    });
    await actions.setDailyValue.run(editor, {
      date: "2027-04-17",
      itemDefinitionId: "item-rec",
      value: "a",
    });
    const base = {
      id: "item-rec",
      key: "rec_item",
      name: "推奨テスト項目",
      valueType: "symbol" as const,
      granularity: "day" as const,
      defaultVisibility: "staff_only" as const,
    };
    // Recommendation 1: dropping the in-use option opt-rec-a is
    // refused, and the message names the option.
    await expect(
      defs.upsertItemDefinition.run(admin, {
        ...base,
        options: [{ id: "opt-rec-b", code: "b", label: "B" }],
      }),
    ).rejects.toThrow("opt-rec-a");
    await expect(
      defs.upsertItemDefinition.run(admin, {
        ...base,
        options: [{ id: "opt-rec-b", code: "b", label: "B" }],
      }),
    ).rejects.toThrow("in use by daily values");
    // Recommendation 2: changing the value type is refused.
    await expect(
      defs.upsertItemDefinition.run(admin, { ...base, valueType: "text" }),
    ).rejects.toThrow("has daily values and cannot change valueType");
    // Recommendation 2: adding an axis is refused too.
    await expect(
      defs.upsertItemDefinition.run(admin, { ...base, targetPlatformAxis: "grade" }),
    ).rejects.toThrow("has daily values and cannot change targetPlatformAxis");
    // An update that keeps the type, the axis and the in-use
    // option (renaming, adding an unused option) still succeeds,
    // and the stored value still resolves to its option.
    const updated = await defs.upsertItemDefinition.run(admin, {
      ...base,
      name: "推奨テスト項目（改名）",
      options: [
        { id: "opt-rec-a", code: "a", label: "A" },
        { id: "opt-rec-b", code: "b", label: "B" },
        { id: "opt-rec-c", code: "c", label: "C" },
      ],
    });
    expect(updated.name).toBe("推奨テスト項目（改名）");
    expect(updated.options.map((o) => o.id)).toEqual(["opt-rec-a", "opt-rec-b", "opt-rec-c"]);
    const read = await actions.getDailyValues.run(editor, {
      from: "2027-04-17",
      to: "2027-04-17",
      itemDefinitionId: "item-rec",
    });
    expect(read.map((r) => r.valueOptionId)).toEqual(["opt-rec-a"]);
  });

  it("sets one value for many targets at once (all grades)", async () => {
    const editor = auth(A, "Editor");
    const targets = [1, 2, 3].map((n) => ({ axis: "grade" as const, id: `grade-${n}` }));
    const rows = await actions.setDailyValuesForTargets.run(editor, {
      date: "2027-04-12",
      itemDefinitionId: "item-dismissal",
      targets,
      value: "15:20",
    });
    expect(rows.map((r) => r.targetKey)).toEqual([
      "grade:grade-1",
      "grade:grade-2",
      "grade:grade-3",
    ]);
    const read = await actions.getDailyValues.run(editor, {
      from: "2027-04-12",
      to: "2027-04-12",
      itemDefinitionId: "item-dismissal",
    });
    expect(read).toHaveLength(3);
    expect(read.every((r) => r.valueTime === "15:20")).toBe(true);
  });

  it("writes nothing when a bulk set fails partway", async () => {
    const editor = auth(A, "Editor");
    // The third entry names a bus target that does not exist for
    // this school: resolution fails after the first two entries
    // were already resolved, and the transaction must not run.
    await expect(
      actions.setDailyValuesForTargets.run(editor, {
        date: "2027-04-13",
        itemDefinitionId: "item-bus",
        targets: [
          { axis: "app", app: "schedule", axisKey: "bus_route", id: "tgt-bus-1" },
          { axis: "app", app: "schedule", axisKey: "bus_route", id: "tgt-bus-2" },
          { axis: "app", app: "schedule", axisKey: "bus_route", id: "tgt-bus-404" },
        ],
        value: "13:00",
      }),
    ).rejects.toThrow("not owned");
    const read = await actions.getDailyValues.run(editor, {
      from: "2027-04-13",
      to: "2027-04-13",
      itemDefinitionId: "item-bus",
    });
    expect(read).toHaveLength(0);

    // A bad value fails the whole bulk set the same way.
    await expect(
      actions.setDailyValuesForTargets.run(editor, {
        date: "2027-04-13",
        itemDefinitionId: "item-dismissal",
        targets: [{ axis: "grade", id: "grade-1" }],
        value: "not-a-time",
      }),
    ).rejects.toThrow("HH:MM");
    const read2 = await actions.getDailyValues.run(editor, {
      from: "2027-04-13",
      to: "2027-04-13",
    });
    expect(read2).toHaveLength(0);
  });

  it("lets Viewer read but not write (4.4 daily.write)", async () => {
    const viewer = auth(A, "Viewer");
    const rows = await actions.getDailyValues.run(viewer, { from: DATE, to: DATE });
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      actions.setDailyValue.run(viewer, {
        date: DATE,
        itemDefinitionId: "item-lunch",
        value: "yes",
      }),
    ).rejects.toBeInstanceOf(AuthAccessError);
    await expect(
      actions.setDailyValuesForTargets.run(viewer, {
        date: DATE,
        itemDefinitionId: "item-dismissal",
        targets: [{ axis: "grade", id: "grade-1" }],
        value: "14:30",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      actions.deleteDailyValue.run(viewer, { date: DATE, itemDefinitionId: "item-lunch" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("deletes a value and refuses a second delete", async () => {
    const editor = auth(A, "Editor");
    await actions.setDailyValue.run(editor, {
      date: "2027-04-14",
      itemDefinitionId: "item-note",
      value: "消す値",
    });
    await actions.deleteDailyValue.run(editor, {
      date: "2027-04-14",
      itemDefinitionId: "item-note",
    });
    const read = await actions.getDailyValues.run(editor, {
      from: "2027-04-14",
      to: "2027-04-14",
    });
    expect(read).toHaveLength(0);
    await expect(
      actions.deleteDailyValue.run(editor, { date: "2027-04-14", itemDefinitionId: "item-note" }),
    ).rejects.toThrow("not found");
  });

  it("isolates schools: no reads, writes or deletes across schools", async () => {
    const editorA = auth(A, "Editor");
    const editorB = auth(B, "Editor");
    await actions.setDailyValue.run(editorA, {
      date: "2027-04-15",
      itemDefinitionId: "item-note",
      value: "Aの値",
    });
    // B's own lunch item works, with B's own option ids.
    const bRow = await actions.setDailyValue.run(editorB, {
      date: "2027-04-15",
      itemDefinitionId: "item-lunch-b",
      value: "yes",
    });
    expect(bRow.valueOptionId).toBe("opt-lunch-b-yes");

    const readB = await actions.getDailyValues.run(editorB, {
      from: "2027-04-15",
      to: "2027-04-15",
    });
    expect(readB.map((r) => r.itemDefinitionId)).toEqual(["item-lunch-b"]);

    // B cannot write through A's item definition, cannot use A's
    // bus target, and cannot delete A's value.
    await expect(
      actions.setDailyValue.run(editorB, {
        date: "2027-04-15",
        itemDefinitionId: "item-note",
        value: "Bの侵入",
      }),
    ).rejects.toThrow("item definition not found");
    await expect(
      actions.setDailyValue.run(editorB, {
        date: "2027-04-15",
        itemDefinitionId: "item-lunch-b",
        target: { axis: "app", app: "schedule", axisKey: "bus_route", id: "tgt-bus-1" },
        value: "yes",
      }),
    ).rejects.toThrow();
    await expect(
      actions.deleteDailyValue.run(editorB, {
        date: "2027-04-15",
        itemDefinitionId: "item-note",
      }),
    ).rejects.toThrow("item definition not found");

    const readA = await actions.getDailyValues.run(editorA, {
      from: "2027-04-15",
      to: "2027-04-15",
      itemDefinitionId: "item-note",
    });
    expect(readA.map((r) => r.valueText)).toEqual(["Aの値"]);
  });
});
