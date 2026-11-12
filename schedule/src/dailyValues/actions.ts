import { eq } from "drizzle-orm";
import { defineActions } from "@school-manage/platform-client";
import type { TargetRef } from "@school-manage/calendar-types";
import type { ValueType } from "../definitions/types.js";
import * as store from "../db/dailyValues.js";
import { itemDefinitions, itemOptions, targetGroups, targets } from "../db/schema.js";
import { assertOwned, tenantDb } from "../db/tenant.js";
import { scheduleAction } from "../permissions.js";
import {
  deleteDailyValueInputSchema,
  getDailyValuesInputSchema,
  setDailyValueInputSchema,
  setDailyValuesForTargetsInputSchema,
} from "./types.js";
import { normalizeSlot, targetKeyOf, validateDailyValue } from "./value.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

interface ResolvedTarget {
  targetId: string | null;
  targetRef: TargetRef | null;
  targetKey: string;
}

/**
 * The daily-value actions (Issue #28), with the permissions of
 * DESIGN-AUTH-TENANCY 4.4: reading a range is view.read, setting
 * and clearing values is daily.write (Admin and Editor; Viewer is
 * refused by the permission table). Referenced definitions and
 * app-axis targets are checked against the caller's school before
 * any write, and the value is checked against the definition's
 * value type by the pure validator, so a bulk set is fully
 * validated before its transaction starts.
 */
export function createDailyValueActions(db: Db) {
  /**
   * Places the requested target on the item's axis. An item varies
   * over at most one axis (Issue #27): an app target must belong to
   * the item's own target group, a shared-master target must name
   * the item's platform axis, and an item with no axis takes no
   * target.
   *
   * A target is required whenever the item has an axis (PR #58
   * review, mandatory 1): daily values are always held per target
   * (DESIGN schedule 4.8.2), so a targetless row next to per-target
   * rows would leave a cell with two answers. "The same value for
   * every target" goes through setDailyValuesForTargets, which
   * writes one row per target. An item with no axis is the only
   * case that takes no target. Both setDailyValue and
   * deleteDailyValue resolve through here, so both enforce this.
   */
  async function resolveTarget(
    auth: { schoolId: string },
    item: typeof itemDefinitions.$inferSelect,
    target: TargetRef | null | undefined,
  ): Promise<ResolvedTarget> {
    if (!target) {
      if (item.targetGroupId || item.targetPlatformAxis) {
        throw new Error(`target is required for an item that varies by target: ${item.id}`);
      }
      return { targetId: null, targetRef: null, targetKey: "" };
    }
    if (target.axis === "app") {
      if (!item.targetGroupId) {
        throw new Error(
          item.targetPlatformAxis
            ? `item varies over the platform axis "${item.targetPlatformAxis}"; an app target does not fit: ${item.id}`
            : `item does not vary by target: ${item.id}`,
        );
      }
      const tdb = tenantDb(db, auth.schoolId);
      const group = await tdb.findById(targetGroups, item.targetGroupId);
      if (!group || group.key !== target.axisKey) {
        throw new Error(
          `target axis "${target.axisKey}" is not the item's target group: ${item.id}`,
        );
      }
      await assertOwned(tdb, targets, [target.id]);
      const row = await tdb.findById(targets, target.id);
      if (!row || row.targetGroupId !== item.targetGroupId) {
        throw new Error(`target does not belong to the item's target group: ${target.id}`);
      }
      return { targetId: target.id, targetRef: null, targetKey: targetKeyOf(target) };
    }
    if (item.targetGroupId) {
      throw new Error(
        `item varies over an app target group; a platform target does not fit: ${item.id}`,
      );
    }
    if (!item.targetPlatformAxis) {
      throw new Error(`item does not vary by target: ${item.id}`);
    }
    if (target.axis !== item.targetPlatformAxis) {
      throw new Error(
        `item varies over the platform axis "${item.targetPlatformAxis}", not "${target.axis}": ${item.id}`,
      );
    }
    // NOTE (PR #58 review, recommendation 3): the existence of a
    // shared-master (platform-axis) target is NOT checked here.
    // Platform ids (grades, classes, ...) live in the platform's
    // masters and cannot be a foreign key from this database, so
    // any id string is accepted for now. Verifying it against the
    // platform masters API (#22) is left to a later issue (#33 or
    // the platform-linkage work).
    return { targetId: null, targetRef: target, targetKey: targetKeyOf(target) };
  }

  async function loadItem(auth: { schoolId: string }, itemDefinitionId: string) {
    const tdb = tenantDb(db, auth.schoolId);
    const item = await tdb.findById(itemDefinitions, itemDefinitionId);
    if (!item) {
      throw new Error(`item definition not found: ${itemDefinitionId}`);
    }
    const options = await tdb.select(itemOptions, eq(itemOptions.itemDefinitionId, item.id));
    return { item, options };
  }

  return defineActions({
    getDailyValues: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getDailyValuesInputSchema.parse(request);
      return store.getDailyValues(db, auth.schoolId, input);
    }),

    setDailyValue: scheduleAction("daily.write", async ({ auth, request }) => {
      const input = setDailyValueInputSchema.parse(request);
      const { item, options } = await loadItem(auth, input.itemDefinitionId);
      const resolved = await resolveTarget(auth, item, input.target);
      const columns = validateDailyValue(item.valueType as ValueType, options, input.value);
      return store.setDailyValue(
        db,
        auth.schoolId,
        {
          date: input.date,
          itemDefinitionId: item.id,
          ...resolved,
          slot: normalizeSlot(input.slot ?? "all_day"),
          columns,
        },
        auth.userId,
      );
    }),

    setDailyValuesForTargets: scheduleAction("daily.write", async ({ auth, request }) => {
      const input = setDailyValuesForTargetsInputSchema.parse(request);
      const { item, options } = await loadItem(auth, input.itemDefinitionId);
      const columns = validateDailyValue(item.valueType as ValueType, options, input.value);
      const slot = normalizeSlot(input.slot ?? "all_day");
      // Every target is resolved (and thereby validated) before
      // the store opens its transaction, so a bad entry late in
      // the list cannot leave the earlier ones written.
      const entries: store.SetDailyValueEntry[] = [];
      for (const target of input.targets) {
        const resolved = await resolveTarget(auth, item, target);
        entries.push({
          date: input.date,
          itemDefinitionId: item.id,
          ...resolved,
          slot,
          columns,
        });
      }
      return store.setDailyValues(db, auth.schoolId, entries, auth.userId);
    }),

    deleteDailyValue: scheduleAction("daily.write", async ({ auth, request }) => {
      const input = deleteDailyValueInputSchema.parse(request);
      const { item } = await loadItem(auth, input.itemDefinitionId);
      const resolved = await resolveTarget(auth, item, input.target);
      const cell: store.DailyValueCell = {
        date: input.date,
        itemDefinitionId: item.id,
        ...resolved,
        slot: normalizeSlot(input.slot ?? "all_day"),
      };
      if (!(await store.deleteDailyValue(db, auth.schoolId, cell))) {
        throw new Error(`daily value not found: ${input.date} ${item.id} ${cell.targetKey}`);
      }
      return { deleted: true };
    }),
  });
}
