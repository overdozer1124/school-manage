import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { publications, type PublicationRow } from "./schema.js";

/**
 * The publications store (Issue #40): the issued versions of
 * DESIGN schedule 4.8. Rows are written once, at publish time,
 * and never updated — the store deliberately offers no update or
 * delete, so an issued document cannot be rewritten through this
 * layer at all. The list read leaves the document behind (it is
 * the one heavy column); the single read returns the whole row.
 */

/** A publication without its document: what the version list
 *  shows (DESIGN schedule 4.8's history columns). */
export type PublicationMeta = Omit<PublicationRow, "documentHtml">;

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
};

/** A stored row as the version list shows it: every field but
 *  the document. */
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
}

export async function insertPublication(
  db: Db,
  schoolId: string,
  input: NewPublication,
): Promise<PublicationRow> {
  const rows = await db
    .insert(publications)
    .values({ schoolId, ...input })
    .returning();
  return rows[0] as PublicationRow;
}

/** The school's publications, newest first; one view's when a
 *  view is named. */
export async function listPublications(
  db: Db,
  schoolId: string,
  viewDefinitionId?: string,
): Promise<PublicationMeta[]> {
  const where = viewDefinitionId
    ? and(eq(publications.schoolId, schoolId), eq(publications.viewDefinitionId, viewDefinitionId))
    : eq(publications.schoolId, schoolId);
  return db
    .select(metaColumns)
    .from(publications)
    .where(where)
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
