import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthAccessError, type AuthContext, type Role } from "@school-manage/platform-client";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDefinitionActions } from "../src/definitions/actions.js";

// Definition tests (Issue #27): item definitions, target axes,
// locations, settings and the three presets, over two-plus schools.
// The DESIGN schedule 5.2 setup scenarios 1, 2, 5 and 7 are covered
// at the definition level: a scenario is expressible when the preset
// plus definition additions alone produce it. Runs only when
// SCHEDULE_DATABASE_URL is set (vitest.config.ts points it at the
// test database).
const url = process.env.SCHEDULE_DATABASE_URL;

type Actions = ReturnType<typeof createDefinitionActions>;

function auth(schoolId: string, role: Role): AuthContext {
  return {
    userId: `user-${schoolId}`,
    schoolId,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

const A = "school-a";
const B = "school-b";

describe.skipIf(!url)("schedule definitions", () => {
  let queryClient: ReturnType<typeof postgres>;
  let actions: Actions;

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
    actions = createDefinitionActions(db);
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("creates, reads back, updates and deletes definitions", async () => {
    const admin = auth(A, "Admin");
    await actions.upsertTargetGroup.run(admin, {
      id: "tg-committee",
      key: "committee",
      name: "委員会",
      sort: 1,
    });
    await actions.upsertTarget.run(admin, {
      id: "tgt-committee-1",
      targetGroupId: "tg-committee",
      code: "broadcast",
      name: "放送委員会",
    });
    const item = await actions.upsertItemDefinition.run(admin, {
      id: "item-duty",
      key: "committee_duty",
      name: "委員会活動",
      valueType: "symbol",
      targetGroupId: "tg-committee",
      granularity: "day",
      defaultVisibility: "staff_only",
      options: [
        { id: "opt-duty-on", code: "on", label: "○", sort: 1 },
        { id: "opt-duty-off", code: "off", label: "×", sort: 2 },
      ],
    });
    expect(item.options.map((o) => o.code)).toEqual(["on", "off"]);

    await actions.upsertLocation.run(admin, { id: "loc-gym", name: "体育館", kind: "体育館" });

    const set = await actions.getDefinitions.run(auth(A, "Viewer"), null);
    expect(set.targetGroups).toHaveLength(1);
    expect(set.targetGroups[0]?.targets.map((t) => t.name)).toEqual(["放送委員会"]);
    expect(set.itemDefinitions.map((i) => i.key)).toEqual(["committee_duty"]);
    expect(set.locations.map((l) => l.name)).toEqual(["体育館"]);

    // Upsert with the same id replaces the row and its options.
    const updated = await actions.upsertItemDefinition.run(admin, {
      id: "item-duty",
      key: "committee_duty",
      name: "委員会当番",
      valueType: "symbol",
      targetGroupId: "tg-committee",
      granularity: "day",
      defaultVisibility: "staff_only",
      options: [{ id: "opt-duty-on", code: "on", label: "○" }],
    });
    expect(updated.name).toBe("委員会当番");
    expect(updated.options).toHaveLength(1);

    await actions.deleteItemDefinition.run(admin, { id: "item-duty" });
    await actions.deleteLocation.run(admin, { id: "loc-gym" });
    const after = await actions.getDefinitions.run(admin, null);
    expect(after.itemDefinitions).toHaveLength(0);
    expect(after.locations).toHaveLength(0);
  });

  it("enforces the 4.4 roles: definitions are Admin-only, locations allow Editor", async () => {
    const editor = auth(A, "Editor");
    const viewer = auth(A, "Viewer");
    await expect(
      actions.upsertItemDefinition.run(editor, {
        id: "item-x",
        key: "x",
        name: "X",
        valueType: "text",
        granularity: "day",
        defaultVisibility: "staff_only",
      }),
    ).rejects.toBeInstanceOf(AuthAccessError);
    await expect(
      actions.upsertTargetGroup.run(editor, { id: "tg-x", key: "x", name: "X" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(actions.applyPreset.run(editor, { preset: "junior_high" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(actions.saveSettings.run(editor, { inputOpener: "modal" })).rejects.toMatchObject({
      status: 403,
    });
    // Locations are master.write: Editor may, Viewer may not.
    await actions.upsertLocation.run(editor, { id: "loc-room", name: "音楽室" });
    await expect(
      actions.upsertLocation.run(viewer, { id: "loc-y", name: "Y" }),
    ).rejects.toMatchObject({ status: 403 });
    await actions.deleteLocation.run(auth(A, "Admin"), { id: "loc-room" });
  });

  it("keeps keys unique per school, not across schools", async () => {
    const payload = {
      key: "lunch",
      name: "給食",
      valueType: "symbol" as const,
      granularity: "day" as const,
      defaultVisibility: "guardian" as const,
    };
    await actions.upsertItemDefinition.run(auth(A, "Admin"), { id: "item-lunch-a", ...payload });
    await actions.upsertItemDefinition.run(auth(B, "Admin"), { id: "item-lunch-b", ...payload });
    // Same id in another school is that school's own row.
    await actions.upsertItemDefinition.run(auth(B, "Admin"), {
      id: "item-lunch-a",
      key: "snack",
      name: "おやつ",
      valueType: "text",
      granularity: "day",
      defaultVisibility: "staff_only",
    });
    await expect(
      actions.upsertItemDefinition.run(auth(A, "Admin"), { id: "item-other", ...payload }),
    ).rejects.toThrow("already exists");
    await actions.deleteItemDefinition.run(auth(A, "Admin"), { id: "item-lunch-a" });
    await actions.deleteItemDefinition.run(auth(B, "Admin"), { id: "item-lunch-b" });
    await actions.deleteItemDefinition.run(auth(B, "Admin"), { id: "item-lunch-a" });
  });

  it("isolates schools: no reads, references or deletes across schools", async () => {
    const adminA = auth(A, "Admin");
    const adminB = auth(B, "Admin");
    await actions.upsertTargetGroup.run(adminA, { id: "tg-a", key: "a_group", name: "Aの軸" });
    await actions.upsertItemDefinition.run(adminA, {
      id: "item-a",
      key: "a_item",
      name: "Aの項目",
      valueType: "text",
      granularity: "day",
      defaultVisibility: "staff_only",
    });

    const setB = await actions.getDefinitions.run(adminB, null);
    expect(setB.targetGroups.map((g) => g.id)).not.toContain("tg-a");
    expect(setB.itemDefinitions.map((i) => i.id)).not.toContain("item-a");

    // B cannot build on A's target group, nor delete A's rows.
    await expect(
      actions.upsertItemDefinition.run(adminB, {
        id: "item-b",
        key: "b_item",
        name: "Bの項目",
        valueType: "text",
        targetGroupId: "tg-a",
        granularity: "day",
        defaultVisibility: "staff_only",
      }),
    ).rejects.toThrow("not owned");
    await expect(
      actions.upsertTarget.run(adminB, { id: "tgt-b", targetGroupId: "tg-a", name: "Bの対象" }),
    ).rejects.toThrow("not owned");
    await expect(actions.deleteItemDefinition.run(adminB, { id: "item-a" })).rejects.toThrow(
      "not found",
    );

    const setA = await actions.getDefinitions.run(adminA, null);
    expect(setA.itemDefinitions.map((i) => i.id)).toEqual(["item-a"]);
    await actions.deleteItemDefinition.run(adminA, { id: "item-a" });
    await actions.deleteTargetGroup.run(adminA, { id: "tg-a" });
  });

  it("rejects an item that names both a platform axis and a target group", async () => {
    await expect(
      actions.upsertItemDefinition.run(auth(A, "Admin"), {
        id: "item-bad",
        key: "bad",
        name: "不正",
        valueType: "time",
        targetGroupId: "tg-committee",
        targetPlatformAxis: "grade",
        granularity: "day",
        defaultVisibility: "staff_only",
      }),
    ).rejects.toThrow();
  });

  it("scenario 1: the no-bus preset has no bus item or bus axis", async () => {
    const school = "school-c";
    const summary = await actions.applyPreset.run(auth(school, "Admin"), {
      preset: "elementary_no_bus",
    });
    expect(summary.insertedItemDefinitions).toBe(3);
    const set = await actions.getDefinitions.run(auth(school, "Admin"), null);
    expect(set.itemDefinitions.map((i) => i.key)).toEqual(["events", "lunch", "dismissal"]);
    expect(set.targetGroups).toHaveLength(0);
    expect(set.settings?.presetKey).toBe("elementary_no_bus");
  });

  it("scenario 2: the bus preset splits dismissal by grade and buses by route", async () => {
    const school = "school-d";
    await actions.applyPreset.run(auth(school, "Admin"), { preset: "elementary_bus" });
    const set = await actions.getDefinitions.run(auth(school, "Admin"), null);
    const dismissal = set.itemDefinitions.find((i) => i.key === "dismissal");
    expect(dismissal?.targetPlatformAxis).toBe("grade");
    expect(dismissal?.valueType).toBe("time");
    const bus = set.itemDefinitions.find((i) => i.key === "bus");
    const busGroup = set.targetGroups.find((g) => g.key === "bus_route");
    expect(bus?.targetGroupId).toBe(busGroup?.id);
    expect(busGroup?.targets.map((t) => t.name)).toEqual(["①便", "②便", "③便", "④便"]);
    const lunch = set.itemDefinitions.find((i) => i.key === "lunch");
    expect(lunch?.options.find((o) => o.code === "yes")?.countsAs).toEqual({ lunch_day: true });
  });

  it("scenario 5: clubs are absent in elementary and two-form in junior high", async () => {
    const elementary = await actions.getDefinitions.run(auth("school-c", "Admin"), null);
    expect(elementary.itemDefinitions.some((i) => i.key.includes("club"))).toBe(false);
    expect(elementary.targetGroups.some((g) => g.key === "club")).toBe(false);

    const school = "school-f";
    await actions.applyPreset.run(auth(school, "Admin"), { preset: "junior_high" });
    const set = await actions.getDefinitions.run(auth(school, "Admin"), null);
    // Whole-school symbol form: no axis.
    const clubDay = set.itemDefinitions.find((i) => i.key === "club_day");
    expect(clubDay?.targetGroupId).toBeNull();
    expect(clubDay?.targetPlatformAxis).toBeNull();
    expect(clubDay?.options.map((o) => o.label)).toContain("練");
    // Per-club form: the item varies over the club axis, and the
    // school adds its own clubs as targets with no schema change.
    const clubActivity = set.itemDefinitions.find((i) => i.key === "club_activity");
    const clubGroup = set.targetGroups.find((g) => g.key === "club");
    expect(clubActivity?.targetGroupId).toBe(clubGroup?.id);
    await actions.upsertTarget.run(auth(school, "Admin"), {
      id: "tgt-club-soccer",
      targetGroupId: clubGroup?.id as string,
      name: "サッカー部",
    });
    const after = await actions.getDefinitions.run(auth(school, "Admin"), null);
    expect(after.targetGroups.find((g) => g.key === "club")?.targets.map((t) => t.name)).toEqual([
      "サッカー部",
    ]);
  });

  it("scenario 7: a meeting column is one added definition", async () => {
    const school = "school-c";
    await actions.upsertItemDefinition.run(auth(school, "Admin"), {
      id: "item-meeting",
      key: "meeting",
      name: "会議",
      valueType: "event_list",
      granularity: "day",
      defaultVisibility: "staff_only",
    });
    const set = await actions.getDefinitions.run(auth(school, "Admin"), null);
    expect(set.itemDefinitions.map((i) => i.key)).toContain("meeting");
  });

  it("re-applying a preset never overwrites a school's edits", async () => {
    const school = "school-d";
    const admin = auth(school, "Admin");
    await actions.upsertItemDefinition.run(admin, {
      id: "item-lunch",
      key: "lunch",
      name: "給食（変更済み）",
      valueType: "symbol",
      granularity: "day",
      defaultVisibility: "guardian",
      isAggregatable: true,
      sort: 2,
    });
    const summary = await actions.applyPreset.run(admin, { preset: "elementary_bus" });
    expect(summary.insertedItemDefinitions).toBe(0);
    expect(summary.skippedItemKeys).toContain("lunch");
    const set = await actions.getDefinitions.run(admin, null);
    expect(set.itemDefinitions.find((i) => i.key === "lunch")?.name).toBe("給食（変更済み）");
  });

  it("saves settings and keeps them through a preset application", async () => {
    const school = "school-g";
    const admin = auth(school, "Admin");
    const saved = await actions.saveSettings.run(admin, { inputOpener: "modal" });
    expect(saved.inputOpener).toBe("modal");
    await actions.applyPreset.run(admin, { preset: "junior_high" });
    const set = await actions.getDefinitions.run(admin, null);
    expect(set.settings?.inputOpener).toBe("modal");
    expect(set.settings?.presetKey).toBe("junior_high");
  });
});
