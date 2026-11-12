import { randomUUID } from "node:crypto";
import { and, asc, between, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { dailyValues, type DailyValueRow } from "./schema.js";
import type { DailyValueColumns } from "../dailyValues/value.js";

/**
 * The daily-value store (Issue #28). Every query carries the
 * school_id condition (DESIGN-AUTH-TENANCY 3.3); the composite
 * foreign keys and the cell unique constraint in the schema are the
 * second line of defence. A cell (school, date, item, target, slot)
 * holds at most one row: setting a value that is already there
 * replaces it, keeping its id and created_by, and refreshing the
 * audit columns (4.7). The bulk set runs in one transaction, so a
 * failure partway leaves no target written.
 */

export interface DailyValueCell {
  date: string;
  itemDefinitionId: string;
  /** Row of `targets` for an app-axis target; null otherwise. */
  targetId: string | null;
  /** TargetRef JSON for a shared-master target; null otherwise. */
  targetRef: DailyValueRow["targetRef"];
  /** Canonical target key ("" when the value is not split). */
  targetKey: string;
  slot: string;
}

export interface SetDailyValueEntry extends DailyValueCell {
  columns: DailyValueColumns;
}

type Executor = Pick<Db, "insert">;

async function upsertOne(
  executor: Executor,
  schoolId: string,
  entry: SetDailyValueEntry,
  actor: string,
): Promise<DailyValueRow> {
  const { columns } = entry;
  const rows = await executor
    .insert(dailyValues)
    .values({
      schoolId,
      id: randomUUID(),
      date: entry.date,
      itemDefinitionId: entry.itemDefinitionId,
      targetId: entry.targetId,
      targetRef: entry.targetRef,
      targetKey: entry.targetKey,
      slot: entry.slot,
      valueText: columns.valueText,
      valueTime: columns.valueTime,
      valueTimeEnd: columns.valueTimeEnd,
      valueNumber: columns.valueNumber,
      valueBoolean: columns.valueBoolean,
      valueOptionId: columns.valueOptionId,
      valuePersonId: columns.valuePersonId,
      valueJson: columns.valueJson,
      createdBy: actor,
      updatedBy: actor,
    })
    .onConflictDoUpdate({
      target: [
        dailyValues.schoolId,
        dailyValues.date,
        dailyValues.itemDefinitionId,
        dailyValues.targetKey,
        dailyValues.slot,
      ],
      set: {
        targetId: entry.targetId,
        targetRef: entry.targetRef,
        valueText: columns.valueText,
        valueTime: columns.valueTime,
        valueTimeEnd: columns.valueTimeEnd,
        valueNumber: columns.valueNumber,
        valueBoolean: columns.valueBoolean,
        valueOptionId: columns.valueOptionId,
        valuePersonId: columns.valuePersonId,
        valueJson: columns.valueJson,
        updatedBy: actor,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0] as DailyValueRow;
}

export async function setDailyValue(
  db: Db,
  schoolId: string,
  entry: SetDailyValueEntry,
  actor: string,
): Promise<DailyValueRow> {
  return upsertOne(db, schoolId, entry, actor);
}

/**
 * Sets the same value for several targets at once ("the same
 * dismissal time for every grade", DESIGN schedule 4.8.2). One
 * transaction: either every target's cell is written or none is.
 */
export async function setDailyValues(
  db: Db,
  schoolId: string,
  entries: readonly SetDailyValueEntry[],
  actor: string,
): Promise<DailyValueRow[]> {
  return db.transaction(async (tx) => {
    const rows: DailyValueRow[] = [];
    for (const entry of entries) {
      rows.push(await upsertOne(tx as unknown as Executor, schoolId, entry, actor));
    }
    return rows;
  });
}

export interface GetDailyValuesQuery {
  from: string;
  to: string;
  itemDefinitionId?: string | undefined;
}

export async function getDailyValues(
  db: Db,
  schoolId: string,
  query: GetDailyValuesQuery,
): Promise<DailyValueRow[]> {
  const conditions = [
    eq(dailyValues.schoolId, schoolId),
    between(dailyValues.date, query.from, query.to),
  ];
  if (query.itemDefinitionId) {
    conditions.push(eq(dailyValues.itemDefinitionId, query.itemDefinitionId));
  }
  return db
    .select()
    .from(dailyValues)
    .where(and(...conditions))
    .orderBy(
      asc(dailyValues.date),
      asc(dailyValues.itemDefinitionId),
      asc(dailyValues.targetKey),
      asc(dailyValues.slot),
    );
}

export async function deleteDailyValue(
  db: Db,
  schoolId: string,
  cell: DailyValueCell,
): Promise<boolean> {
  const rows = await db
    .delete(dailyValues)
    .where(
      and(
        eq(dailyValues.schoolId, schoolId),
        eq(dailyValues.date, cell.date),
        eq(dailyValues.itemDefinitionId, cell.itemDefinitionId),
        eq(dailyValues.targetKey, cell.targetKey),
        eq(dailyValues.slot, cell.slot),
      ),
    )
    .returning();
  return rows.length > 0;
}
