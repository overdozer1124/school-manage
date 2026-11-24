import { and, desc, eq, gte, isNull, lt, lte, or } from "drizzle-orm";
import { addDays } from "@school-manage/calendar-types";
import type { Db } from "./client.js";
import { publications, type PublicationSnapshot, type PublicationRow } from "./schema.js";

/**
 * The publications store (Issue #40): the issued versions of
 * DESIGN schedule 4.8. The document and the structured snapshot
 * are written once, at publish time, and never updated — this
 * layer offers no way to rewrite them, so an issued document
 * cannot change through here at all. Issue #48 adds the record
 * keeping around them: the version label and the note may be
 * corrected (updatePublicationMeta), and an issue may be
 * cancelled (cancelPublication stamps cancelled_at; the row
 * stays, as a cancelled version in the history). Issue #49
 * records the issued span on each new row (range_from /
 * range_to); periodOf derives a row's period from them, or
 * from its target month for the rows that predate spans. The
 * list read leaves the two heavy columns behind (the document
 * and the snapshot); the single read returns the whole row.
 */

/** A publication without its document and snapshot: what the
 *  version list shows (DESIGN schedule 4.8's history columns). */
export type PublicationMeta = Omit<PublicationRow, "documentHtml" | "snapshotJson">;

const metaColumns = {
  schoolId: publications.schoolId,
  id: publications.id,
  viewDefinitionId: publications.viewDefinitionId,
  targetMonth: publications.targetMonth,
  versionLabel: publications.versionLabel,
  publishedAt: publications.publishedAt,
  publishedBy: publications.publishedBy,
  snapshotNote: publications.snapshotNote,
  printSettings: publications.printSettings,
  documentFormat: publications.documentFormat,
  cancelledAt: publications.cancelledAt,
  rangeFrom: publications.rangeFrom,
  rangeTo: publications.rangeTo,
};

/** A stored row as the version list shows it: every field but
 *  the document and the snapshot. */
export function toPublicationMeta(row: PublicationRow): PublicationMeta {
  return {
    schoolId: row.schoolId,
    id: row.id,
    viewDefinitionId: row.viewDefinitionId,
    targetMonth: row.targetMonth,
    versionLabel: row.versionLabel,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
    snapshotNote: row.snapshotNote,
    printSettings: row.printSettings,
    documentFormat: row.documentFormat,
    cancelledAt: row.cancelledAt,
    rangeFrom: row.rangeFrom,
    rangeTo: row.rangeTo,
  };
}

/** The last day of a "YYYY-MM" month. */
function monthEndOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const next = mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

/**
 * The period one publication covers (Issue #49): the span it
 * was issued with, or — for a version issued before spans were
 * recorded, whose range columns are null — its target month,
 * first day to last. Every period question (the previous
 * version of a diff, the latest version a public range
 * announces) is asked through this derivation, so the rows
 * written before spans existed answer exactly as the month
 * versions they are.
 */
export function periodOf(row: Pick<PublicationRow, "targetMonth" | "rangeFrom" | "rangeTo">): {
  from: string;
  to: string;
} {
  if (row.rangeFrom && row.rangeTo) return { from: row.rangeFrom, to: row.rangeTo };
  return { from: `${row.targetMonth}-01`, to: monthEndOf(row.targetMonth) };
}

export interface NewPublication {
  id: string;
  viewDefinitionId: string;
  targetMonth: string;
  versionLabel: string;
  publishedAt: Date;
  publishedBy: string;
  snapshotNote: string | null;
  printSettings: PublicationRow["printSettings"];
  documentFormat: string;
  documentHtml: string;
  /** The structured snapshot (Issue #48); a caller that has
   *  none to store (a fixture, a legacy-shaped insert) leaves
   *  it out and the row carries null — an undiffable version. */
  snapshotJson?: PublicationSnapshot | null;
  /** The issued span (Issue #49); a caller that issues a plain
   *  month the old way leaves them out and the row carries
   *  null — its period is then its target month (periodOf). */
  rangeFrom?: string | null;
  rangeTo?: string | null;
}

export async function insertPublication(
  db: Db,
  schoolId: string,
  input: NewPublication,
): Promise<PublicationRow> {
  const rows = await db
    .insert(publications)
    .values({
      schoolId,
      ...input,
      snapshotJson: input.snapshotJson ?? null,
      rangeFrom: input.rangeFrom ?? null,
      rangeTo: input.rangeTo ?? null,
    })
    .returning();
  return rows[0] as PublicationRow;
}

/** The school's publications, newest first; one view's when a
 *  view is named, one month's when a month is named (Issue #48:
 *  the version list filters by view and by month). */
export async function listPublications(
  db: Db,
  schoolId: string,
  viewDefinitionId?: string,
  targetMonth?: string,
): Promise<PublicationMeta[]> {
  const conditions = [eq(publications.schoolId, schoolId)];
  if (viewDefinitionId) conditions.push(eq(publications.viewDefinitionId, viewDefinitionId));
  if (targetMonth) conditions.push(eq(publications.targetMonth, targetMonth));
  return db
    .select(metaColumns)
    .from(publications)
    .where(and(...conditions))
    .orderBy(desc(publications.publishedAt), desc(publications.id));
}

/** One publication with its document, or null when it is not
 *  this school's. */
export async function getPublication(
  db: Db,
  schoolId: string,
  id: string,
): Promise<PublicationRow | null> {
  const rows = await db
    .select()
    .from(publications)
    .where(and(eq(publications.schoolId, schoolId), eq(publications.id, id)));
  return (rows[0] as PublicationRow | undefined) ?? null;
}

/**
 * The version issued immediately before one publication (Issue
 * #48): the same view's, covering the same period (Issue #49:
 * periodOf's derivation, so a month version's predecessor is
 * the previous version of that month, a week version's the
 * previous issue of the same week), the greatest (published_at,
 * id) strictly below the given one's — the version ordering the
 * list shows, newest first. Cancelled versions count: a version
 * that was later cancelled was still the previous issue when
 * the next one came out. Null when the given version is the
 * first of its view and period.
 */
export async function getPreviousPublication(
  db: Db,
  schoolId: string,
  current: Pick<
    PublicationRow,
    "viewDefinitionId" | "targetMonth" | "rangeFrom" | "rangeTo" | "publishedAt" | "id"
  >,
): Promise<PublicationRow | null> {
  const period = periodOf(current);
  // A stored row covers the same period when its span columns
  // name it, or when it predates spans (null) and its target
  // month IS the period — which only a plain month period can
  // be: a week or a year span never equals a month span.
  const isMonthSpan =
    period.from === `${period.from.slice(0, 7)}-01` &&
    period.to === monthEndOf(period.from.slice(0, 7));
  const samePeriod = isMonthSpan
    ? or(
        and(eq(publications.rangeFrom, period.from), eq(publications.rangeTo, period.to)),
        and(isNull(publications.rangeFrom), eq(publications.targetMonth, period.from.slice(0, 7))),
      )
    : and(eq(publications.rangeFrom, period.from), eq(publications.rangeTo, period.to));
  const rows = await db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.schoolId, schoolId),
        eq(publications.viewDefinitionId, current.viewDefinitionId),
        samePeriod,
        or(
          lt(publications.publishedAt, current.publishedAt),
          and(eq(publications.publishedAt, current.publishedAt), lt(publications.id, current.id)),
        ),
      ),
    )
    .orderBy(desc(publications.publishedAt), desc(publications.id))
    .limit(1);
  return (rows[0] as PublicationRow | undefined) ?? null;
}

/**
 * Corrects a version's label and/or note (Issue #48). Only
 * those two columns are set — the document and the snapshot are
 * not part of the update and cannot change here. A cancelled
 * version's record stands as it was left, so the where clause
 * carries the not-cancelled condition itself: a cancellation
 * landing between the caller's read and this update makes the
 * update match nothing. Returns the updated meta, or null when
 * the publication is not this school's or is already cancelled.
 */
export async function updatePublicationMeta(
  db: Db,
  schoolId: string,
  id: string,
  patch: { versionLabel?: string; snapshotNote?: string | null },
): Promise<PublicationMeta | null> {
  const set: { versionLabel?: string; snapshotNote?: string | null } = {};
  if (patch.versionLabel !== undefined) set.versionLabel = patch.versionLabel;
  if (patch.snapshotNote !== undefined) set.snapshotNote = patch.snapshotNote;
  const rows = await db
    .update(publications)
    .set(set)
    .where(
      and(
        eq(publications.schoolId, schoolId),
        eq(publications.id, id),
        isNull(publications.cancelledAt),
      ),
    )
    .returning();
  const row = rows[0] as PublicationRow | undefined;
  return row ? toPublicationMeta(row) : null;
}

/**
 * Cancels one publication (Issue #48): stamps cancelled_at and
 * keeps the row. Only a version not yet cancelled is stamped —
 * the where clause carries that, so a second cancellation
 * updates nothing and answers null.
 */
export async function cancelPublication(
  db: Db,
  schoolId: string,
  id: string,
  cancelledAt: Date,
): Promise<PublicationMeta | null> {
  const rows = await db
    .update(publications)
    .set({ cancelledAt })
    .where(
      and(
        eq(publications.schoolId, schoolId),
        eq(publications.id, id),
        isNull(publications.cancelledAt),
      ),
    )
    .returning();
  const row = rows[0] as PublicationRow | undefined;
  return row ? toPublicationMeta(row) : null;
}

/**
 * The latest version a public reader is told about (Issue #48):
 * the newest non-cancelled publication of the view whose
 * period contains the given date (Issue #49: periodOf's
 * derivation — a month version contains the days of its month,
 * a week version the days of its week, a year version the
 * whole school year). A cancelled version is withdrawn, so it
 * never names itself the latest; when every covering version
 * is cancelled — or none was issued — there is no latest
 * version to announce.
 */
export async function getLatestPublicationContaining(
  db: Db,
  schoolId: string,
  viewDefinitionId: string,
  date: string,
): Promise<{ versionLabel: string; publishedAt: Date } | null> {
  const rows = await db
    .select({
      versionLabel: publications.versionLabel,
      publishedAt: publications.publishedAt,
    })
    .from(publications)
    .where(
      and(
        eq(publications.schoolId, schoolId),
        eq(publications.viewDefinitionId, viewDefinitionId),
        isNull(publications.cancelledAt),
        or(
          and(lte(publications.rangeFrom, date), gte(publications.rangeTo, date)),
          and(isNull(publications.rangeFrom), eq(publications.targetMonth, date.slice(0, 7))),
        ),
      ),
    )
    .orderBy(desc(publications.publishedAt), desc(publications.id))
    .limit(1);
  return rows[0] ?? null;
}
