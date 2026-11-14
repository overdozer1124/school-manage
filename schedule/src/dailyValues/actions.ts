import { defineActions } from "@school-manage/platform-client";
import type { ValueType } from "../definitions/types.js";
import * as store from "../db/dailyValues.js";
import { tenantDb } from "../db/tenant.js";
import { scheduleAction } from "../permissions.js";
import { createTargetResolver, loadItemWithOptions } from "./target.js";
import {
  deleteDailyValueInputSchema,
  getDailyValuesInputSchema,
  setDailyValueInputSchema,
  setDailyValuesForTargetsInputSchema,
} from "./types.js";
import { normalizeSlot, validateDailyValue } from "./value.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

/**
 * The daily-value actions (Issue #28), with the permissions of
 * DESIGN-AUTH-TENANCY 4.4: reading a range is view.read, setting
 * and clearing values is daily.write (Admin and Editor; Viewer is
 * refused by the permission table). Referenced definitions and
 * app-axis targets are checked against the caller's school before
 * any write (see target.ts, shared with the event values), and the
 * value is checked against the definition's value type by the pure
 * validator, so a bulk set is fully validated before its transaction
 * starts.
 */
export function createDailyValueActions(db: Db) {
  const resolver = createTargetResolver(db);
  const loadItem = (auth: { schoolId: string }, itemDefinitionId: string) =>
    loadItemWithOptions(db, auth.schoolId, itemDefinitionId);

  return defineActions({
    getDailyValues: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getDailyValuesInputSchema.parse(request);
      return store.getDailyValues(db, auth.schoolId, input);
    }),

    setDailyValue: scheduleAction("daily.write", async ({ auth, request }) => {
      const input = setDailyValueInputSchema.parse(request);
      const { item, options } = await loadItem(auth, input.itemDefinitionId);
      const resolved = await resolver.resolveTarget(auth.schoolId, item, input.target);
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
        const resolved = await resolver.resolveTarget(auth.schoolId, item, target);
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
      const resolved = await resolver.resolveTarget(auth.schoolId, item, input.target);
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
