import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
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
 * stays, as a cancelled version in the history). The list read
 * leaves the two heavy columns behind (the document and the
 * snapshot); the single read returns the whole row.
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
  };
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
}

export async function insertPublication(
  db: Db,
  schoolId: string,
  input: NewPublication,
): Promise<PublicationRow> {
  const rows = await db
    .insert(publications)
    .values({ schoolId, ...input, snapshotJson: input.snapshotJson ?? null })
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
 * #48): the same view's same month, the greatest (published_at,
 * id) strictly below the given one's — the version ordering the
 * list shows, newest first. Cancelled versions count: a version
 * that was later cancelled was still the previous issue when
 * the next one came out. Null when the given version is the
 * first of its view and month.
 */
export async function getPreviousPublication(
  db: Db,
  schoolId: string,
  current: Pick<PublicationRow, "viewDefinitionId" | "targetMonth" | "publishedAt" | "id">,
): Promise<PublicationRow | null> {
  const rows = await db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.schoolId, schoolId),
        eq(publications.viewDefinitionId, current.viewDefinitionId),
        eq(publications.targetMonth, current.targetMonth),
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
 * not part of the update and cannot change here. Returns the
 * updated meta, or null when the publication is not this
 * school's.
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
    .where(and(eq(publications.schoolId, schoolId), eq(publications.id, id)))
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
 * the newest non-cancelled publication of one view's one month.
 * A cancelled version is withdrawn, so it never names itself
 * the latest; when every version of the month is cancelled —
 * or none was issued — there is no latest version to announce.
 */
export async function getLatestPublicationForMonth(
  db: Db,
  schoolId: string,
  viewDefinitionId: string,
  targetMonth: string,
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
        eq(publications.targetMonth, targetMonth),
        isNull(publications.cancelledAt),
      ),
    )
    .orderBy(desc(publications.publishedAt), desc(publications.id))
    .limit(1);
  return rows[0] ?? null;
}
