import { defineActions } from "@school-manage/platform-client";
import * as store from "../db/views.js";
import { itemDefinitions, targetGroups } from "../db/schema.js";
import { assertOwned, tenantDb } from "../db/tenant.js";
import { scheduleAction } from "../permissions.js";
import {
  deleteViewInputSchema,
  updateColumnWidthInputSchema,
  viewDefinitionInputSchema,
} from "./types.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

/**
 * The view actions (Issue #32), declared with the permissions of
 * DESIGN-AUTH-TENANCY 4.4: reading is view.read, changing a view
 * definition (name, layout, audience, columns) is definition.write
 * (Admin only), and a column's width is view.layout (Admin and
 * Editor) so the people who run the schedule day to day can adjust
 * widths without touching definitions. Referenced item definitions
 * and target groups are checked with assertOwned before the store
 * writes, so a column naming another school's item fails before any
 * row is touched.
 */
export function createViewActions(db: Db) {
  return defineActions({
    getViews: scheduleAction("view.read", async ({ auth }) => store.getViews(db, auth.schoolId)),

    upsertViewDefinition: scheduleAction("definition.write", async ({ auth, request }) => {
      const input = viewDefinitionInputSchema.parse(request);
      if (input.columns && input.columns.length > 0) {
        const tdb = tenantDb(db, auth.schoolId);
        const itemIds = input.columns
          .map((c) => c.itemDefinitionId)
          .filter((id): id is string => id != null);
        if (itemIds.length > 0) await assertOwned(tdb, itemDefinitions, itemIds);
        const groupIds = input.columns
          .map((c) => c.targetGroupId)
          .filter((id): id is string => id != null);
        if (groupIds.length > 0) await assertOwned(tdb, targetGroups, groupIds);
      }
      return store.upsertViewDefinition(db, auth.schoolId, input);
    }),

    deleteViewDefinition: scheduleAction("definition.write", async ({ auth, request }) => {
      const { id } = deleteViewInputSchema.parse(request);
      if (!(await store.deleteViewDefinition(db, auth.schoolId, id))) {
        throw new Error(`view definition not found: ${id}`);
      }
      return { deleted: true };
    }),

    updateViewColumnWidth: scheduleAction("view.layout", async ({ auth, request }) => {
      const input = updateColumnWidthInputSchema.parse(request);
      const column = await store.updateColumnWidth(db, auth.schoolId, input);
      if (!column) {
        throw new Error(`view column not found: ${input.viewId}/${input.columnId}`);
      }
      return column;
    }),
  });
}
