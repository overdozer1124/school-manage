import { eq } from "drizzle-orm";
import type { TargetRef } from "@school-manage/calendar-types";
import { itemDefinitions, itemOptions, targetGroups, targets } from "../db/schema.js";
import { assertOwned, tenantDb } from "../db/tenant.js";
import { targetKeyOf } from "./value.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

export type ItemDefinitionRow = typeof itemDefinitions.$inferSelect;
export type ItemOptionRow = typeof itemOptions.$inferSelect;

export interface ResolvedTarget {
  targetId: string | null;
  targetRef: TargetRef | null;
  targetKey: string;
}

const NO_TARGET: ResolvedTarget = { targetId: null, targetRef: null, targetKey: "" };

/** Loads one of the caller's school's item definitions with its
 *  options; a missing (or other school's) id is an error, so a value
 *  can never be checked against another school's definition. */
export async function loadItemWithOptions(
  db: Db,
  schoolId: string,
  itemDefinitionId: string,
): Promise<{ item: ItemDefinitionRow; options: ItemOptionRow[] }> {
  const tdb = tenantDb(db, schoolId);
  const item = await tdb.findById(itemDefinitions, itemDefinitionId);
  if (!item) {
    throw new Error(`item definition not found: ${itemDefinitionId}`);
  }
  const options = await tdb.select(itemOptions, eq(itemOptions.itemDefinitionId, item.id));
  return { item, options };
}

/**
 * Places a value's target on its item's axis, shared by the daily
 * values (Issue #28) and the event values (Issue #29): both store a
 * target the same way (target_id for an app-axis row, a TargetRef
 * for a shared-master one, the canonical target_key over both), and
 * both check the fit the same way when a target IS given — an app
 * target must belong to the item's own target group, a shared-master
 * target must name the item's platform axis, and an item with no
 * axis takes no target.
 *
 * The two callers differ only on a missing target. Daily values
 * require one whenever the item has an axis (PR #58 review,
 * mandatory 1: daily values are always held per target, DESIGN
 * schedule 4.8.2), so they use resolveTarget. Event values keep the
 * target optional (DESIGN schedule 4.5: target_id nullable), so
 * they use resolveOptionalTarget.
 */
export function createTargetResolver(db: Db) {
  async function fitTarget(
    schoolId: string,
    item: ItemDefinitionRow,
    target: TargetRef,
  ): Promise<ResolvedTarget> {
    if (target.axis === "app") {
      if (!item.targetGroupId) {
        throw new Error(
          item.targetPlatformAxis
            ? `item varies over the platform axis "${item.targetPlatformAxis}"; an app target does not fit: ${item.id}`
            : `item does not vary by target: ${item.id}`,
        );
      }
      const tdb = tenantDb(db, schoolId);
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

  /** Daily values: a target is required whenever the item has an axis. */
  async function resolveTarget(
    schoolId: string,
    item: ItemDefinitionRow,
    target: TargetRef | null | undefined,
  ): Promise<ResolvedTarget> {
    if (!target) {
      if (item.targetGroupId || item.targetPlatformAxis) {
        throw new Error(`target is required for an item that varies by target: ${item.id}`);
      }
      return NO_TARGET;
    }
    return fitTarget(schoolId, item, target);
  }

  /** Event values: the target is optional (DESIGN schedule 4.5). */
  async function resolveOptionalTarget(
    schoolId: string,
    item: ItemDefinitionRow,
    target: TargetRef | null | undefined,
  ): Promise<ResolvedTarget> {
    if (!target) return NO_TARGET;
    return fitTarget(schoolId, item, target);
  }

  return { resolveTarget, resolveOptionalTarget };
}
