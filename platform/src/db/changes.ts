import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { ChangeEntityKind, ChangeEvent } from "@school-manage/calendar-types";
import type { Db } from "./client.js";
import { outbox, type OutboxRow } from "./schema.js";

/**
 * The change outbox and the save helpers around it (Issue #21,
 * DESIGN-INTEGRATION 3.1 / 3.2 / 7.1). Writes to the school calendar
 * and the shared masters go through saveWithChange, so the business
 * row and its change event commit in one transaction: a failed write
 * leaves no event behind, and a written row never lacks one. Products
 * refetch what they missed through listChanges (exposed as
 * GET /platform/api/v1/changes), keyed by the platform-wide `seq`.
 * The event shape is the shared package's changeEventSchema, so the
 * outbox columns and the wire format cannot drift apart.
 */

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ChangeInput {
  schoolId: string;
  kind: ChangeEntityKind;
  entityId: string;
  /** The entity's revision after this change. */
  revision: number;
  op: ChangeEvent["op"];
  actor: ChangeEvent["actor"];
}

function toChangeEvent(row: OutboxRow): ChangeEvent {
  return {
    seq: row.seq,
    schoolId: row.schoolId,
    kind: row.kind,
    entityId: row.entityId,
    revision: row.revision,
    op: row.op,
    occurredAt: row.occurredAt.toISOString(),
    actor: { userId: row.actorUserId, via: row.actorVia },
  };
}

/**
 * Appends one change event inside the caller's transaction.
 *
 * Appends are serialized with a transaction-scoped advisory lock:
 * `seq` is a bigserial assigned at insert time, not at commit time,
 * so without serialization a transaction that inserted seq 1 but
 * committed after seq 2 would surface seq 1 only after readers had
 * already advanced their watermark to 2 — and `after=2` would never
 * return it (the change would be lost for good, breaking the
 * refetch guarantee of DESIGN-INTEGRATION 7.1). Holding the lock
 * until the transaction ends makes insert order and commit order
 * agree; appendChange runs last in a write, so the lock is held
 * only briefly.
 */
export async function appendChange(tx: Transaction, change: ChangeInput): Promise<ChangeEvent> {
  // 727001 is a fixed key reserved for the outbox; no other feature
  // may take an advisory lock with this key.
  await tx.execute(sql`select pg_advisory_xact_lock(727001)`);
  const rows = await tx
    .insert(outbox)
    .values({
      schoolId: change.schoolId,
      kind: change.kind,
      entityId: change.entityId,
      revision: change.revision,
      op: change.op,
      actorUserId: change.actor.userId,
      actorVia: change.actor.via,
    })
    .returning();
  return toChangeEvent(rows[0] as OutboxRow);
}

/**
 * Runs `write` and records its change event in a single transaction:
 * if the write throws, the event is not recorded either (and the
 * event's insert failing rolls the write back too).
 *
 * `change` may be a plain value, or a function of the write's result
 * for values only the write itself can know — above all the revision
 * an update produced (see updateRevisioned): computing it on the
 * caller side (`expectedRevision + 1`) can drift from the revision
 * the update actually stamped.
 */
export async function saveWithChange<T>(
  db: Db,
  change: ChangeInput | ((result: T) => ChangeInput),
  write: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await write(tx);
    const input = typeof change === "function" ? change(result) : change;
    await appendChange(tx, input);
    return result;
  });
}

/**
 * A table carrying the shared entity meta (the calendar-types
 * entities): identity, the optimistic-lock revision and the
 * last-writer stamp.
 */
export type RevisionedTable = PgTable & {
  schoolId: PgColumn;
  id: PgColumn;
  revision: PgColumn;
  updatedBy: PgColumn;
  updatedVia: PgColumn;
};

type RevisionedRow<T extends RevisionedTable> = T["$inferSelect"];
type RevisionedSet<T extends RevisionedTable> = Partial<
  Omit<RevisionedRow<T>, "schoolId" | "id" | "revision" | "updatedBy" | "updatedVia">
>;

/**
 * A save arrived with a stale revision (3.1). Carries the current row
 * so the caller can answer 409 with the latest content attached.
 */
export class RevisionConflictError extends Error {
  readonly status = 409;
  constructor(readonly latest: unknown) {
    super("revision conflict: the row was changed by someone else");
    this.name = "RevisionConflictError";
  }
}

/**
 * The generic table typing is erased at this single point, as in
 * tenant.ts: the public signature above is fully typed, and the
 * runtime calls are the ordinary drizzle builders (a bare generic
 * table type is rejected by drizzle's update()).
 */
interface LooseTx {
  update(table: PgTable): {
    set(values: Record<string, unknown>): {
      where(cond: SQL | undefined): { returning(): Promise<unknown[]> };
    };
  };
  select(): {
    from(table: PgTable): {
      where(cond: SQL | undefined): { limit(count: number): Promise<unknown[]> };
    };
  };
}

/**
 * Updates one revisioned row under the optimistic lock (3.1): the
 * update applies only when the stored revision still equals
 * `expectedRevision`, and stamps revision + 1, updated_by and
 * updated_via (from the actor). When another save got there first,
 * throws RevisionConflictError carrying the latest row; when the row
 * does not exist in this school at all, throws a plain Error.
 * Runs inside the caller's transaction, so saveWithChange can record
 * the event with the revision this update produced.
 */
export async function updateRevisioned<T extends RevisionedTable>(
  tx: Transaction,
  table: T,
  args: {
    schoolId: string;
    id: string;
    expectedRevision: number;
    actor: ChangeEvent["actor"];
    set: RevisionedSet<T>;
  },
): Promise<RevisionedRow<T>> {
  const loose = tx as unknown as LooseTx;
  const values: Record<string, unknown> = {
    ...(args.set as Record<string, unknown>),
    revision: args.expectedRevision + 1,
    updatedBy: args.actor.userId,
    updatedVia: args.actor.via,
  };
  const updated = await loose
    .update(table)
    .set(values)
    .where(
      and(
        eq(table.schoolId, args.schoolId),
        eq(table.id, args.id),
        eq(table.revision, args.expectedRevision),
      ),
    )
    .returning();
  if (updated.length > 0) return updated[0] as RevisionedRow<T>;
  const latest = await loose
    .select()
    .from(table)
    .where(and(eq(table.schoolId, args.schoolId), eq(table.id, args.id)))
    .limit(1);
  if (latest.length > 0) throw new RevisionConflictError(latest[0]);
  throw new Error(`updateRevisioned: no row ${args.id} in school ${args.schoolId}`);
}

/** The read side of the outbox, behind the refetch endpoint. */
export interface ChangeStore {
  /** A school's changes after `after`, oldest first, at most `limit`. */
  listChanges(schoolId: string, after: number, limit: number): Promise<ChangeEvent[]>;
}

export function createChangeStore(db: Db): ChangeStore {
  return {
    async listChanges(schoolId, after, limit) {
      const rows = await db
        .select()
        .from(outbox)
        .where(and(eq(outbox.schoolId, schoolId), gt(outbox.seq, after)))
        .orderBy(asc(outbox.seq))
        .limit(limit);
      return rows.map(toChangeEvent);
    },
  };
}
