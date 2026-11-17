import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthContext, type Role } from "@school-manage/platform-client";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDefinitionActions } from "../src/definitions/actions.js";
import { PlatformRelayError } from "../src/platformClient.js";
import { createViewActions } from "../src/views/actions.js";

// Item deletion refusal tests (Issue #88): an item definition a
// view column still uses cannot be deleted — the view_columns
// foreign key is no action by design, and the raw 23503 used to
// surface as an opaque 500. The refusal is now a 409 naming the
// views that use the item, and it reaches the screen as-is. An
// item no view uses deletes exactly as before.
const url = process.env.SCHEDULE_DATABASE_URL;

const SCHOOL = "school-88";

type DefinitionActions = ReturnType<typeof createDefinitionActions>;
type ViewActions = ReturnType<typeof createViewActions>;

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

describe.skipIf(!url)("schedule item deletion in use (Issue #88)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let definitions: DefinitionActions;
  let views: ViewActions;

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
    definitions = createDefinitionActions(db);
    views = createViewActions(db);

    const schoolAdmin = auth(SCHOOL, "Admin");
    await definitions.upsertItemDefinition.run(schoolAdmin, {
      id: "item-used",
      key: "used_item",
      name: "使われている項目",
      valueType: "event_list",
      granularity: "day",
      defaultVisibility: "staff_only",
      options: [],
    });
    await definitions.upsertItemDefinition.run(schoolAdmin, {
      id: "item-unused",
      key: "unused_item",
      name: "使われていない項目",
      valueType: "event_list",
      granularity: "day",
      defaultVisibility: "staff_only",
      options: [],
    });
    await views.upsertViewDefinition.run(schoolAdmin, {
      id: "view-month",
      name: "職員用月表",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [{ id: "col-used", sourceKind: "daily_item", itemDefinitionId: "item-used" }],
    });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("refuses to delete an item a view uses, with a 409 naming the view, and the item stays", async () => {
    const admin = auth(SCHOOL, "Admin");
    const error: unknown = await definitions.deleteItemDefinition
      .run(admin, { id: "item-used" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect(error).toMatchObject({ status: 409 });
    expect((error as PlatformRelayError).body).toEqual({
      error: "この項目はビューで使われているので削除できません（使われているビュー：職員用月表）",
    });

    // The item definition and the view column are untouched.
    const set = await definitions.getDefinitions.run(admin, null);
    expect(set.itemDefinitions.map((i) => i.id)).toContain("item-used");
    const viewList = await views.getViews.run(admin, {});
    const view = viewList.find((v) => v.id === "view-month");
    expect(view?.columns.map((c) => c.itemDefinitionId)).toContain("item-used");

    // Once the view is gone, the same item deletes as before:
    // the refusal tracks the view use, nothing else.
    await expect(views.deleteViewDefinition.run(admin, { id: "view-month" })).resolves.toEqual({
      deleted: true,
    });
    await expect(definitions.deleteItemDefinition.run(admin, { id: "item-used" })).resolves.toEqual(
      { deleted: true },
    );
  });

  it("deletes an item no view uses, exactly as before", async () => {
    const admin = auth(SCHOOL, "Admin");
    await expect(
      definitions.deleteItemDefinition.run(admin, { id: "item-unused" }),
    ).resolves.toEqual({ deleted: true });
    const set = await definitions.getDefinitions.run(admin, null);
    expect(set.itemDefinitions.map((i) => i.id)).not.toContain("item-unused");
  });
});
