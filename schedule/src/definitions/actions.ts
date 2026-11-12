import { defineActions } from "@school-manage/platform-client";
import * as store from "../db/definitions.js";
import { targetGroups, targets } from "../db/schema.js";
import { assertOwned, tenantDb } from "../db/tenant.js";
import { scheduleAction } from "../permissions.js";
import {
  applyPresetInputSchema,
  deleteInputSchema,
  itemDefinitionInputSchema,
  locationInputSchema,
  saveSettingsInputSchema,
  targetGroupInputSchema,
  targetInputSchema,
} from "./types.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

/**
 * The definition actions (Issue #27), declared with the permissions
 * of DESIGN-AUTH-TENANCY 4.4: reading is view.read, item definitions
 * and target axes are definition.write (Admin only), locations are
 * master.write (Admin and Editor), settings and preset application
 * are school.admin. Referenced ids are checked with assertOwned
 * before the store writes, so a request naming another school's
 * target group fails before any row is touched.
 */
export function createDefinitionActions(db: Db) {
  return defineActions({
    getDefinitions: scheduleAction("view.read", async ({ auth }) =>
      store.getDefinitionSet(db, auth.schoolId),
    ),

    upsertTargetGroup: scheduleAction("definition.write", async ({ auth, request }) => {
      const input = targetGroupInputSchema.parse(request);
      return store.upsertTargetGroup(db, auth.schoolId, input);
    }),

    deleteTargetGroup: scheduleAction("definition.write", async ({ auth, request }) => {
      const { id } = deleteInputSchema.parse(request);
      if (!(await store.deleteTargetGroup(db, auth.schoolId, id))) {
        throw new Error(`target group not found: ${id}`);
      }
      return { deleted: true };
    }),

    upsertTarget: scheduleAction("definition.write", async ({ auth, request }) => {
      const input = targetInputSchema.parse(request);
      const tdb = tenantDb(db, auth.schoolId);
      await assertOwned(tdb, targetGroups, [input.targetGroupId]);
      if (input.parentTargetId) {
        await assertOwned(tdb, targets, [input.parentTargetId]);
        // A parent must sit on the same axis as its child: a target
        // of another group is owned by the school too, so the
        // ownership check alone would let it through (PR #56
        // review, recommendation 3).
        const parent = await tdb.findById(targets, input.parentTargetId);
        if (parent && parent.targetGroupId !== input.targetGroupId) {
          throw new Error(
            `parent target belongs to a different target group: ${input.parentTargetId}`,
          );
        }
      }
      return store.upsertTarget(db, auth.schoolId, input);
    }),

    deleteTarget: scheduleAction("definition.write", async ({ auth, request }) => {
      const { id } = deleteInputSchema.parse(request);
      if (!(await store.deleteTarget(db, auth.schoolId, id))) {
        throw new Error(`target not found: ${id}`);
      }
      return { deleted: true };
    }),

    upsertItemDefinition: scheduleAction("definition.write", async ({ auth, request }) => {
      const input = itemDefinitionInputSchema.parse(request);
      if (input.targetGroupId) {
        const tdb = tenantDb(db, auth.schoolId);
        await assertOwned(tdb, targetGroups, [input.targetGroupId]);
      }
      return store.upsertItemDefinition(db, auth.schoolId, input);
    }),

    deleteItemDefinition: scheduleAction("definition.write", async ({ auth, request }) => {
      const { id } = deleteInputSchema.parse(request);
      if (!(await store.deleteItemDefinition(db, auth.schoolId, id))) {
        throw new Error(`item definition not found: ${id}`);
      }
      return { deleted: true };
    }),

    upsertLocation: scheduleAction("master.write", async ({ auth, request }) => {
      const input = locationInputSchema.parse(request);
      return store.upsertLocation(db, auth.schoolId, input);
    }),

    deleteLocation: scheduleAction("master.write", async ({ auth, request }) => {
      const { id } = deleteInputSchema.parse(request);
      if (!(await store.deleteLocation(db, auth.schoolId, id))) {
        throw new Error(`location not found: ${id}`);
      }
      return { deleted: true };
    }),

    saveSettings: scheduleAction("school.admin", async ({ auth, request }) => {
      const input = saveSettingsInputSchema.parse(request);
      return store.saveSettings(db, auth.schoolId, input.inputOpener);
    }),

    applyPreset: scheduleAction("school.admin", async ({ auth, request }) => {
      const input = applyPresetInputSchema.parse(request);
      return store.applyPreset(db, auth.schoolId, input.preset);
    }),
  });
}
