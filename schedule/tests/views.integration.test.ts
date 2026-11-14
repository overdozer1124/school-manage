import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthContext, type Role } from "@school-manage/platform-client";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { dutyDefinitions } from "../src/db/schema.js";
import { createDefinitionActions } from "../src/definitions/actions.js";
import { createViewActions } from "../src/views/actions.js";

// View tests (Issue #32): view_definitions and view_columns over
// two schools, the 4.4 role split (definitions are Admin-only,
// column widths are view.layout and open to Editor), and the
// per-school name uniqueness. Runs only when SCHEDULE_DATABASE_URL
// is set (vitest.config.ts points it at the test database).
const url = process.env.SCHEDULE_DATABASE_URL;

type ViewActions = ReturnType<typeof createViewActions>;
type DefinitionActions = ReturnType<typeof createDefinitionActions>;

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

describe.skipIf(!url)("schedule views", () => {
  let queryClient: ReturnType<typeof postgres>;
  let views: ViewActions;
  let definitions: DefinitionActions;

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
    views = createViewActions(db);
    definitions = createDefinitionActions(db);

    // A duty definition for the duty column below to key into:
    // since Issue #30 view_columns.duty_definition_id is a real
    // foreign key, so the id must exist (it was a free id in #32).
    await db.insert(dutyDefinitions).values({
      schoolId: A,
      id: "duty-nitiban",
      name: "日番",
      granularity: "day",
      applicablePeriod: "all_year",
    });

    // One item and one axis per school, for columns to reference.
    for (const [school, suffix] of [
      [A, "a"],
      [B, "b"],
    ] as const) {
      const adminAuth = auth(school, "Admin");
      await definitions.upsertTargetGroup.run(adminAuth, {
        id: `tg-grade-${suffix}`,
        key: "grade_local",
        name: "学年（自校）",
      });
      await definitions.upsertItemDefinition.run(adminAuth, {
        id: `item-dismissal-${suffix}`,
        key: "dismissal",
        name: "下校時刻",
        valueType: "time_range",
        targetGroupId: `tg-grade-${suffix}`,
        granularity: "day",
        defaultVisibility: "guardian",
      });
    }
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("creates a view with every column kind and reads it back in order", async () => {
    const admin = auth(A, "Admin");
    const view = await views.upsertViewDefinition.run(admin, {
      id: "view-staff-month",
      name: "職員用月表",
      layout: "month_rows",
      layoutParams: { weekStart: 1 },
      audience: "staff",
      periodScope: "month",
      printSettings: { paper: "A4", orientation: "landscape" },
      columns: [
        { id: "col-day", sourceKind: "day_attribute", sort: 1 },
        { id: "col-events", sourceKind: "event_category", sort: 2 },
        {
          id: "col-dismissal",
          sourceKind: "daily_item",
          itemDefinitionId: "item-dismissal-a",
          targetGroupId: "tg-grade-a",
          sort: 3,
        },
        { id: "col-duty", sourceKind: "duty", dutyDefinitionId: "duty-nitiban", sort: 4 },
      ],
    });
    expect(view.layoutParams).toEqual({ weekStart: 1 });
    expect(view.printSettings).toEqual({ paper: "A4", orientation: "landscape" });
    expect(view.columns.map((c) => c.id)).toEqual([
      "col-day",
      "col-events",
      "col-dismissal",
      "col-duty",
    ]);
    // group_same_values defaults to on (DESIGN 4.8.2).
    expect(view.columns.every((c) => c.groupSameValues)).toBe(true);

    const read = await views.getViews.run(auth(A, "Viewer"), null);
    expect(read.map((v) => v.id)).toEqual(["view-staff-month"]);
    expect(read[0]?.columns).toHaveLength(4);
    // School B sees none of A's views.
    expect(await views.getViews.run(auth(B, "Admin"), null)).toEqual([]);
  });

  it("accepts Phase 2 layouts in definitions", async () => {
    const admin = auth(A, "Admin");
    for (const [id, layout] of [
      ["view-year", "year_columns"],
      ["view-grid", "calendar_grid"],
      ["view-club", "transposed"],
    ] as const) {
      const view = await views.upsertViewDefinition.run(admin, {
        id,
        name: `表示 ${layout}`,
        layout,
        audience: "guardian",
        periodScope: "year",
        columns: [],
      });
      expect(view.layout).toBe(layout);
      await views.deleteViewDefinition.run(admin, { id });
    }
  });

  it("replaces columns wholesale when they are given, keeps them when not", async () => {
    const admin = auth(A, "Admin");
    const replaced = await views.upsertViewDefinition.run(admin, {
      id: "view-staff-month",
      name: "職員用月表",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [{ id: "col-only", sourceKind: "event_category", sort: 1 }],
    });
    expect(replaced.columns.map((c) => c.id)).toEqual(["col-only"]);

    const kept = await views.upsertViewDefinition.run(admin, {
      id: "view-staff-month",
      name: "職員用月表（改）",
      layout: "week_rows",
      audience: "staff",
      periodScope: "two_weeks",
    });
    expect(kept.name).toBe("職員用月表（改）");
    expect(kept.columns.map((c) => c.id)).toEqual(["col-only"]);
  });

  it("keeps view names unique per school, not across schools", async () => {
    await expect(
      views.upsertViewDefinition.run(auth(A, "Admin"), {
        id: "view-dup",
        name: "職員用月表（改）",
        layout: "month_rows",
        audience: "staff",
        periodScope: "month",
        columns: [],
      }),
    ).rejects.toThrow(/view name already exists/);
    const other = await views.upsertViewDefinition.run(auth(B, "Admin"), {
      id: "view-dup",
      name: "職員用月表（改）",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [],
    });
    expect(other.schoolId).toBe(B);
  });

  it("refuses columns that reference another school's item or target group", async () => {
    await expect(
      views.upsertViewDefinition.run(auth(A, "Admin"), {
        id: "view-cross",
        name: "他校参照",
        layout: "month_rows",
        audience: "staff",
        periodScope: "month",
        columns: [
          {
            id: "col-cross",
            sourceKind: "daily_item",
            itemDefinitionId: "item-dismissal-b",
            sort: 1,
          },
        ],
      }),
    ).rejects.toThrow(/not owned by school/);
    await expect(
      views.upsertViewDefinition.run(auth(A, "Admin"), {
        id: "view-cross",
        name: "他校参照",
        layout: "month_rows",
        audience: "staff",
        periodScope: "month",
        columns: [
          {
            id: "col-cross",
            sourceKind: "daily_item",
            itemDefinitionId: "item-dismissal-a",
            targetGroupId: "tg-grade-b",
            sort: 1,
          },
        ],
      }),
    ).rejects.toThrow(/not owned by school/);
  });

  it("enforces the 4.4 roles: Editor cannot change definitions but can change column widths", async () => {
    const admin = auth(A, "Admin");
    const editor = auth(A, "Editor");
    const viewer = auth(A, "Viewer");
    await views.upsertViewDefinition.run(admin, {
      id: "view-roles",
      name: "役割テスト",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [{ id: "col-width", sourceKind: "event_category", sort: 1 }],
    });

    await expect(
      views.upsertViewDefinition.run(editor, {
        id: "view-roles",
        name: "役割テスト",
        layout: "month_rows",
        audience: "staff",
        periodScope: "month",
        columns: [],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      views.deleteViewDefinition.run(editor, { id: "view-roles" }),
    ).rejects.toMatchObject({ status: 403 });

    // view.layout: Editor (and Admin) may change a width; the
    // definition itself is untouched.
    const widened = await views.updateViewColumnWidth.run(editor, {
      viewId: "view-roles",
      columnId: "col-width",
      widthHint: 24,
    });
    expect(widened.widthHint).toBe(24);
    const after = await views.getViews.run(admin, null);
    const roles = after.find((v) => v.id === "view-roles");
    expect(roles?.name).toBe("役割テスト");
    expect(roles?.columns[0]?.widthHint).toBe(24);

    await expect(
      views.updateViewColumnWidth.run(viewer, {
        viewId: "view-roles",
        columnId: "col-width",
        widthHint: 10,
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Another school's column is not found, not leaked.
    await expect(
      views.updateViewColumnWidth.run(auth(B, "Admin"), {
        viewId: "view-roles",
        columnId: "col-width",
        widthHint: 10,
      }),
    ).rejects.toThrow(/view column not found/);
  });

  it("deleting a view removes its columns; an item used by a view cannot be deleted", async () => {
    const admin = auth(A, "Admin");
    await views.upsertViewDefinition.run(admin, {
      id: "view-uses-item",
      name: "項目使用",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [
        {
          id: "col-uses-item",
          sourceKind: "daily_item",
          itemDefinitionId: "item-dismissal-a",
          sort: 1,
        },
      ],
    });
    await expect(
      definitions.deleteItemDefinition.run(admin, { id: "item-dismissal-a" }),
    ).rejects.toThrow();
    await views.deleteViewDefinition.run(admin, { id: "view-uses-item" });
    const after = await views.getViews.run(admin, null);
    expect(after.find((v) => v.id === "view-uses-item")).toBeUndefined();
  });
});
