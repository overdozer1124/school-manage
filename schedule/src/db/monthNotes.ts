import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "./client.js";
import { viewMonthNotes } from "./schema.js";

/**
 * The view month notes store (Issue #46): one view's monthly
 * accompanying notes — the student table's 生活目標・健康目標
 * (DESIGN schedule 7: monthly metadata carried as the view's
 * accompanying information). Every query carries the school_id
 * condition (DESIGN-AUTH-TENANCY 3.3), and the view is always
 * named: a note belongs to one view's one month, never to the
 * month itself, so another view of the same month reads none of
 * it. The shape the store deals in is the note itself (month and
 * the two goals); the row's school and view are the caller's
 * context, not part of the note.
 */

export interface ViewMonthNote {
  month: string;
  lifeGoal: string | null;
  healthGoal: string | null;
}

/** One view's notes for the months a range covers, oldest month
 *  first: the notes of every month from fromMonth to toMonth
 *  (both YYYY-MM, inclusive) that stand written. A month with no
 *  row is simply absent — nothing was written for it. */
export async function getViewMonthNotes(
  db: Db,
  schoolId: string,
  viewId: string,
  fromMonth: string,
  toMonth: string,
): Promise<ViewMonthNote[]> {
  const rows = await db
    .select()
    .from(viewMonthNotes)
    .where(
      and(
        eq(viewMonthNotes.schoolId, schoolId),
        eq(viewMonthNotes.viewDefinitionId, viewId),
        gte(viewMonthNotes.month, fromMonth),
        lte(viewMonthNotes.month, toMonth),
      ),
    )
    .orderBy(asc(viewMonthNotes.month));
  return rows.map((row) => ({
    month: row.month,
    lifeGoal: row.lifeGoal,
    healthGoal: row.healthGoal,
  }));
}

/** Writes one view's one month of notes, replacing what stood
 *  there (the row is the month's whole note: writing is how a
 *  goal is set, changed, or — with null — cleared). Returns the
 *  note as written. */
export async function setViewMonthNote(
  db: Db,
  schoolId: string,
  input: { viewId: string } & ViewMonthNote,
): Promise<ViewMonthNote> {
  const rows = await db
    .insert(viewMonthNotes)
    .values({
      schoolId,
      viewDefinitionId: input.viewId,
      month: input.month,
      lifeGoal: input.lifeGoal,
      healthGoal: input.healthGoal,
    })
    .onConflictDoUpdate({
      target: [viewMonthNotes.schoolId, viewMonthNotes.viewDefinitionId, viewMonthNotes.month],
      set: { lifeGoal: input.lifeGoal, healthGoal: input.healthGoal },
    })
    .returning();
  const row = rows[0] as { month: string; lifeGoal: string | null; healthGoal: string | null };
  return { month: row.month, lifeGoal: row.lifeGoal, healthGoal: row.healthGoal };
}
