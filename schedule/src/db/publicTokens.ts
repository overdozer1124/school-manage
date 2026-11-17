import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { publicViewTokens, type PublicViewTokenRow } from "./schema.js";

/**
 * The public view tokens store (Issue #41): the rows behind the
 * public URLs of DESIGN-AUTH-TENANCY 4.5. A row carries only the
 * token's hash — the raw token exists in the issuing response and
 * in the URL the school hands out, nowhere in this database.
 * Revocation is an update of revoked_at (the row stays, as the
 * record of the issue and its end); there is no delete.
 */

/** A token row as lists show it: every stored field. There is no
 *  raw token to leave behind — the hash is all that was stored. */
export type PublicViewTokenMeta = PublicViewTokenRow;

export interface NewPublicViewToken {
  id: string;
  viewDefinitionId: string;
  tokenHash: string;
  createdBy: string;
}

export async function insertPublicViewToken(
  db: Db,
  schoolId: string,
  input: NewPublicViewToken,
): Promise<PublicViewTokenRow> {
  const rows = await db
    .insert(publicViewTokens)
    .values({ schoolId, ...input })
    .returning();
  return rows[0] as PublicViewTokenRow;
}

/** The school's tokens, newest first; one view's when a view is
 *  named. */
export async function listPublicViewTokens(
  db: Db,
  schoolId: string,
  viewDefinitionId?: string,
): Promise<PublicViewTokenRow[]> {
  const where = viewDefinitionId
    ? and(
        eq(publicViewTokens.schoolId, schoolId),
        eq(publicViewTokens.viewDefinitionId, viewDefinitionId),
      )
    : eq(publicViewTokens.schoolId, schoolId);
  return db
    .select()
    .from(publicViewTokens)
    .where(where)
    .orderBy(desc(publicViewTokens.createdAt), desc(publicViewTokens.id));
}

/**
 * The row a presented token's hash names, whichever school it
 * belongs to: the hash is the credential, and it is unique across
 * schools (the schema's unique constraint), so the lookup needs no
 * school. Returns revoked rows too — the caller decides what a
 * revoked token means (the public actions answer 401).
 */
export async function findPublicViewTokenByHash(
  db: Db,
  tokenHash: string,
): Promise<PublicViewTokenRow | null> {
  const rows = await db
    .select()
    .from(publicViewTokens)
    .where(eq(publicViewTokens.tokenHash, tokenHash));
  return (rows[0] as PublicViewTokenRow | undefined) ?? null;
}

/**
 * Marks one of the school's tokens revoked and returns the row, or
 * null when the id is not this school's. Revoking an already
 * revoked token is a no-op that returns the row as it stands: the
 * end state the caller asked for is already the state.
 */
export async function revokePublicViewToken(
  db: Db,
  schoolId: string,
  id: string,
  revokedAt: Date,
): Promise<PublicViewTokenRow | null> {
  const updated = await db
    .update(publicViewTokens)
    .set({ revokedAt })
    .where(
      and(
        eq(publicViewTokens.schoolId, schoolId),
        eq(publicViewTokens.id, id),
        isNull(publicViewTokens.revokedAt),
      ),
    )
    .returning();
  if (updated[0]) return updated[0] as PublicViewTokenRow;
  const rows = await db
    .select()
    .from(publicViewTokens)
    .where(and(eq(publicViewTokens.schoolId, schoolId), eq(publicViewTokens.id, id)));
  return (rows[0] as PublicViewTokenRow | undefined) ?? null;
}
