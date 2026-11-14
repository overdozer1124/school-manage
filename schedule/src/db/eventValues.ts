import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { eventValues, type EventValueRow } from "./schema.js";
import type { DailyValueColumns } from "../dailyValues/value.js";

/**
 * The event-value store (Issue #29). Every query carries the
 * school_id condition (DESIGN-AUTH-TENANCY 3.3); the composite
 * foreign keys in the schema are the second line of defence. A
 * subject (a platform event or absence) holds one value per
 * (item, target): the write replaces the subject's whole set in one
 * transaction, which is what makes the retry after a failed save
 * safe — sending the same set again lands it exactly once
 * (DESIGN-INTEGRATION 10, the two-database save order).
 */

export type EventSubjectKind = "event" | "absence";

export interface EventValueEntry {
  itemDefinitionId: string;
  /** Row of `targets` for an app-axis target; null otherwise. */
  targetId: string | null;
  /** TargetRef JSON for a shared-master target; null otherwise. */
  targetRef: EventValueRow["targetRef"];
  /** Canonical target key ("" when the value is not split). */
  targetKey: string;
  columns: DailyValueColumns;
}

export async function replaceEventValues(
  db: Db,
  schoolId: string,
  subjectKind: EventSubjectKind,
  subjectId: string,
  entries: readonly EventValueEntry[],
  actor: string,
): Promise<EventValueRow[]> {
  return db.transaction(async (tx) => {
    await tx
      .delete(eventValues)
      .where(
        and(
          eq(eventValues.schoolId, schoolId),
          eq(eventValues.subjectKind, subjectKind),
          eq(eventValues.subjectId, subjectId),
        ),
      );
    if (entries.length === 0) return [];
    const rows = await tx
      .insert(eventValues)
      .values(
        entries.map((entry) => ({
          schoolId,
          id: randomUUID(),
          subjectKind,
          subjectId,
          itemDefinitionId: entry.itemDefinitionId,
          targetId: entry.targetId,
          targetRef: entry.targetRef,
          targetKey: entry.targetKey,
          valueText: entry.columns.valueText,
          valueTime: entry.columns.valueTime,
          valueTimeEnd: entry.columns.valueTimeEnd,
          valueNumber: entry.columns.valueNumber,
          valueBoolean: entry.columns.valueBoolean,
          valueOptionId: entry.columns.valueOptionId,
          valuePersonId: entry.columns.valuePersonId,
          valueJson: entry.columns.valueJson,
          createdBy: actor,
          updatedBy: actor,
        })),
      )
      .returning();
    return rows as EventValueRow[];
  });
}

export async function getEventValues(
  db: Db,
  schoolId: string,
  subjectKind: EventSubjectKind,
  subjectId: string,
): Promise<EventValueRow[]> {
  return db
    .select()
    .from(eventValues)
    .where(
      and(
        eq(eventValues.schoolId, schoolId),
        eq(eventValues.subjectKind, subjectKind),
        eq(eventValues.subjectId, subjectId),
      ),
    )
    .orderBy(asc(eventValues.itemDefinitionId), asc(eventValues.targetKey));
}

/** Removes a subject's values; returns how many rows were removed. */
export async function deleteEventValues(
  db: Db,
  schoolId: string,
  subjectKind: EventSubjectKind,
  subjectId: string,
): Promise<number> {
  const rows = await db
    .delete(eventValues)
    .where(
      and(
        eq(eventValues.schoolId, schoolId),
        eq(eventValues.subjectKind, subjectKind),
        eq(eventValues.subjectId, subjectId),
      ),
    )
    .returning();
  return rows.length;
}
