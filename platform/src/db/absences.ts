import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  defaultLeaveSubdivisions,
  type Absence,
  type AbsenceInput,
  type AbsenceSubdivisionInput,
  type AbsenceSubdivisionRecord,
  type Certainty,
  type ChangeEvent,
} from "@school-manage/calendar-types";
import {
  RevisionConflictError,
  saveWithChange,
  updateRevisioned,
  type RevisionedTable,
} from "./changes.js";
import type { Db } from "./client.js";
import {
  absenceSubdivisions,
  absences,
  staffMembers,
  type AbsenceRow,
  type AbsenceSubdivisionRow,
} from "./schema.js";

/**
 * The staff absences and the schools' subdivision definitions
 * (Issue #25, DESIGN-INTEGRATION 2.3 / 8-1-1, DESIGN-AUTH-TENANCY
 * 4.5 / 4.6). Every write goes through the #21 helpers, so the row
 * and its outbox event commit together, and updates are guarded by
 * the revision optimistic lock. Reads are scoped to one school.
 *
 * The certainty decision — whose save may confirm, whose save is
 * always tentative — belongs to the routes, which know the caller's
 * roles; the store receives the certainty to store and keeps the
 * confirmation stamps consistent with it:
 * - tentative: confirmed_by / confirmed_at are cleared;
 * - confirmed, newly: the actor and the moment are stamped;
 * - confirmed, already confirmed: the original stamps stay.
 * The table's absences_confirmation_stamps check is the second line
 * of defence.
 *
 * The subdivision an absence names is private (4.5), so a 409 never
 * carries the full record: absenceConflictLatest picks the fields a
 * client needs to show "someone else changed this", as the events
 * store does.
 */

type Actor = ChangeEvent["actor"];
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The absence or subdivision does not exist in this school (404). */
export class AbsenceNotFoundError extends Error {
  constructor(
    readonly entryKind: "absence" | "absence_subdivision",
    id: string,
  ) {
    super(`${entryKind} not found: ${id}`);
    this.name = "AbsenceNotFoundError";
  }
}

/** The write conflicts with the current state (409). */
export class AbsenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbsenceConflictError";
  }
}

/**
 * The write points at data that is not in this school (400) — a staff
 * member of another school, or a subdivision key the school has not
 * defined under that kind.
 */
export class AbsenceReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbsenceReferenceError";
  }
}

/**
 * What a 409 answer may carry about the current absence. The
 * subdivision, the purpose and the note stay out: the subdivision is
 * private (4.5) and the texts are the owner's own words.
 */
export interface AbsenceConflictLatest {
  id: string;
  revision: number;
  staffId: string;
  fromDate: string;
  toDate: string;
  kind: Absence["kind"];
  certainty: Certainty;
  updatedBy: string;
  updatedVia: Absence["updatedVia"];
}

export function absenceConflictLatest(record: Absence): AbsenceConflictLatest {
  return {
    id: record.id,
    revision: record.revision,
    staffId: record.staffId,
    fromDate: record.fromDate,
    toDate: record.toDate,
    kind: record.kind,
    certainty: record.certainty,
    updatedBy: record.updatedBy,
    updatedVia: record.updatedVia,
  };
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

function mapAbsenceWriteError(error: unknown, context: "write" | "remove"): never {
  const code = pgCode(error);
  if (code === "23505") {
    throw new AbsenceConflictError("an absence with the same id already exists in this school");
  }
  if (code === "23503") {
    if (context === "remove") {
      throw new AbsenceConflictError("this absence is still referenced by other data");
    }
    throw new AbsenceReferenceError("this absence references data that is not in this school");
  }
  throw error;
}

function mapSubdivisionWriteError(error: unknown, context: "write" | "remove"): never {
  const code = pgCode(error);
  if (code === "23505") {
    throw new AbsenceConflictError(
      "a subdivision with the same id or the same kind and key already exists in this school",
    );
  }
  if (code === "23503" && context === "remove") {
    throw new AbsenceConflictError("this subdivision is still used by an absence");
  }
  throw error;
}

interface LooseSource {
  select(): {
    from(table: PgTable): {
      where(cond: ReturnType<typeof and>): Promise<Record<string, unknown>[]>;
    };
  };
  insert(table: PgTable): {
    values(values: Record<string, unknown>): {
      returning(): Promise<Record<string, unknown>[]>;
    };
  };
  delete(table: PgTable): {
    where(cond: ReturnType<typeof and>): Promise<unknown>;
  };
}

function absenceToRecord(row: AbsenceRow): Absence {
  return {
    schoolId: row.schoolId,
    id: row.id,
    revision: row.revision,
    updatedBy: row.updatedBy,
    updatedVia: row.updatedVia,
    staffId: row.staffId,
    fromDate: row.fromDate,
    toDate: row.toDate,
    time: row.time as Absence["time"],
    kind: row.kind as Absence["kind"],
    certainty: row.certainty as Certainty,
    purpose: row.purpose,
    note: row.note,
    createdBy: row.createdBy,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    subdivisionKey: row.subdivisionKey,
  };
}

function subdivisionToRecord(row: AbsenceSubdivisionRow): AbsenceSubdivisionRecord {
  return {
    schoolId: row.schoolId,
    id: row.id,
    revision: row.revision,
    updatedBy: row.updatedBy,
    updatedVia: row.updatedVia,
    code: row.code as AbsenceSubdivisionRecord["code"],
    key: row.key,
    label: row.label,
  };
}

export interface AbsenceStore {
  /** The school's absences overlapping [from, to], by start date. */
  listRange(schoolId: string, range: { from: string; to: string }): Promise<Absence[]>;
  /** The school's absences still waiting for confirmation （確認待ち,
   *  4.6), by start date. */
  listPending(schoolId: string): Promise<Absence[]>;
  /** One absence, or undefined when the school has none by that id. */
  get(schoolId: string, id: string): Promise<Absence | undefined>;
  create(input: AbsenceInput, actor: Actor, certainty: Certainty): Promise<Absence>;
  update(
    input: AbsenceInput & { revision: number },
    actor: Actor,
    certainty: Certainty,
  ): Promise<Absence>;
  /** Marks the absence confirmed, stamping the confirmer (4.6). An
   *  already-confirmed absence is returned as it stands. */
  confirm(schoolId: string, id: string, expectedRevision: number, actor: Actor): Promise<Absence>;
  remove(schoolId: string, id: string, expectedRevision: number, actor: Actor): Promise<void>;
}

export interface AbsenceSubdivisionStore {
  /** The school's subdivision definitions, by kind then key. */
  list(schoolId: string): Promise<AbsenceSubdivisionRecord[]>;
  get(schoolId: string, id: string): Promise<AbsenceSubdivisionRecord | undefined>;
  create(input: AbsenceSubdivisionInput, actor: Actor): Promise<AbsenceSubdivisionRecord>;
  update(
    input: AbsenceSubdivisionInput & { revision: number },
    actor: Actor,
  ): Promise<AbsenceSubdivisionRecord>;
  remove(schoolId: string, id: string, expectedRevision: number, actor: Actor): Promise<void>;
  /**
   * Applies the initial leave subdivisions (schedule DESIGN 6.5),
   * insert-missing-only like the schedule presets: definitions the
   * school already has — by kind and key — are left exactly as they
   * are. Returns the definitions this call created.
   */
  applyDefaults(schoolId: string, actor: Actor): Promise<AbsenceSubdivisionRecord[]>;
}

/** The staff member an absence is about must be this school's. */
async function assertStaff(source: LooseSource, schoolId: string, staffId: string): Promise<void> {
  const rows = await source
    .select()
    .from(staffMembers as unknown as PgTable)
    .where(and(eq(staffMembers.schoolId, schoolId), eq(staffMembers.id, staffId)));
  if (rows.length === 0) {
    throw new AbsenceReferenceError(`staff member not in this school: ${staffId}`);
  }
}

/** A named subdivision must be defined by this school under the kind. */
async function assertSubdivision(
  source: LooseSource,
  schoolId: string,
  kind: Absence["kind"],
  subdivisionKey: string | null,
): Promise<void> {
  if (subdivisionKey === null) return;
  const rows = await source
    .select()
    .from(absenceSubdivisions as unknown as PgTable)
    .where(
      and(
        eq(absenceSubdivisions.schoolId, schoolId),
        eq(absenceSubdivisions.code, kind),
        eq(absenceSubdivisions.key, subdivisionKey),
      ),
    );
  if (rows.length === 0) {
    throw new AbsenceReferenceError(
      `subdivision not defined in this school: ${kind}/${subdivisionKey}`,
    );
  }
}

export function createAbsenceStore(db: Db): AbsenceStore {
  async function loadRecord(
    source: Db | Transaction,
    schoolId: string,
    id: string,
  ): Promise<Absence | undefined> {
    const rows = (await (source as unknown as LooseSource)
      .select()
      .from(absences as unknown as PgTable)
      .where(and(eq(absences.schoolId, schoolId), eq(absences.id, id)))) as unknown as
      AbsenceRow[] | [];
    return rows[0] ? absenceToRecord(rows[0]) : undefined;
  }

  return {
    async listRange(schoolId, range) {
      const rows = await db
        .select()
        .from(absences)
        .where(
          and(
            eq(absences.schoolId, schoolId),
            lte(absences.fromDate, range.to),
            gte(absences.toDate, range.from),
          ),
        )
        .orderBy(asc(absences.fromDate), asc(absences.staffId), asc(absences.id));
      return rows.map(absenceToRecord);
    },

    async listPending(schoolId) {
      const rows = await db
        .select()
        .from(absences)
        .where(and(eq(absences.schoolId, schoolId), eq(absences.certainty, "tentative")))
        .orderBy(asc(absences.fromDate), asc(absences.staffId), asc(absences.id));
      return rows.map(absenceToRecord);
    },

    async get(schoolId, id) {
      return loadRecord(db, schoolId, id);
    },

    async create(input, actor, certainty) {
      try {
        return await saveWithChange(
          db,
          {
            schoolId: input.schoolId,
            kind: "absence",
            entityId: input.id,
            revision: 1,
            op: "upsert",
            actor,
          },
          async (tx) => {
            const source = tx as unknown as LooseSource;
            await assertStaff(source, input.schoolId, input.staffId);
            await assertSubdivision(source, input.schoolId, input.kind, input.subdivisionKey);
            const confirmed = certainty === "confirmed";
            const inserted = await source
              .insert(absences as unknown as PgTable)
              .values({
                schoolId: input.schoolId,
                id: input.id,
                staffId: input.staffId,
                fromDate: input.fromDate,
                toDate: input.toDate,
                time: input.time,
                kind: input.kind,
                subdivisionKey: input.subdivisionKey,
                purpose: input.purpose,
                note: input.note,
                certainty,
                createdBy: actor.userId,
                confirmedBy: confirmed ? actor.userId : null,
                confirmedAt: confirmed ? new Date() : null,
                revision: 1,
                updatedBy: actor.userId,
                updatedVia: actor.via,
              })
              .returning();
            return absenceToRecord(inserted[0] as unknown as AbsenceRow);
          },
        );
      } catch (error) {
        if (error instanceof AbsenceReferenceError) throw error;
        mapAbsenceWriteError(error, "write");
      }
    },

    async update(input, actor, certainty) {
      try {
        return await saveWithChange(
          db,
          (updated: Absence) => ({
            schoolId: input.schoolId,
            kind: "absence" as const,
            entityId: input.id,
            revision: updated.revision,
            op: "upsert" as const,
            actor,
          }),
          async (tx) => {
            const existing = await loadRecord(tx, input.schoolId, input.id);
            if (!existing) throw new AbsenceNotFoundError("absence", input.id);
            const source = tx as unknown as LooseSource;
            await assertStaff(source, input.schoolId, input.staffId);
            await assertSubdivision(source, input.schoolId, input.kind, input.subdivisionKey);
            // The confirmation stamps follow the stored certainty:
            // tentative clears them, staying confirmed keeps the
            // original confirmer, becoming confirmed stamps the actor.
            const stamps =
              certainty === "tentative"
                ? { confirmedBy: null, confirmedAt: null }
                : existing.certainty === "confirmed"
                  ? { confirmedBy: existing.confirmedBy, confirmedAt: existing.confirmedAt }
                  : { confirmedBy: actor.userId, confirmedAt: new Date() };
            try {
              const updated = (await updateRevisioned(tx, absences as unknown as RevisionedTable, {
                schoolId: input.schoolId,
                id: input.id,
                expectedRevision: input.revision,
                actor,
                set: {
                  staffId: input.staffId,
                  fromDate: input.fromDate,
                  toDate: input.toDate,
                  time: input.time,
                  kind: input.kind,
                  subdivisionKey: input.subdivisionKey,
                  purpose: input.purpose,
                  note: input.note,
                  certainty,
                  ...stamps,
                } as never,
              })) as unknown as AbsenceRow;
              return absenceToRecord(updated);
            } catch (error) {
              if (error instanceof RevisionConflictError) {
                throw new RevisionConflictError(absenceConflictLatest(existing));
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (
          error instanceof AbsenceNotFoundError ||
          error instanceof AbsenceReferenceError ||
          error instanceof RevisionConflictError
        ) {
          throw error;
        }
        mapAbsenceWriteError(error, "write");
      }
    },

    async confirm(schoolId, id, expectedRevision, actor) {
      const existing = await loadRecord(db, schoolId, id);
      if (!existing) throw new AbsenceNotFoundError("absence", id);
      if (existing.revision !== expectedRevision) {
        throw new RevisionConflictError(absenceConflictLatest(existing));
      }
      if (existing.certainty === "confirmed") return existing;
      try {
        return await saveWithChange(
          db,
          (updated: Absence) => ({
            schoolId,
            kind: "absence" as const,
            entityId: id,
            revision: updated.revision,
            op: "upsert" as const,
            actor,
          }),
          async (tx) => {
            const current = await loadRecord(tx, schoolId, id);
            if (!current) throw new AbsenceNotFoundError("absence", id);
            try {
              const updated = (await updateRevisioned(tx, absences as unknown as RevisionedTable, {
                schoolId,
                id,
                expectedRevision,
                actor,
                set: {
                  certainty: "confirmed",
                  confirmedBy: actor.userId,
                  confirmedAt: new Date(),
                } as never,
              })) as unknown as AbsenceRow;
              return absenceToRecord(updated);
            } catch (error) {
              if (error instanceof RevisionConflictError) {
                throw new RevisionConflictError(absenceConflictLatest(current));
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (error instanceof AbsenceNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapAbsenceWriteError(error, "write");
      }
    },

    async remove(schoolId, id, expectedRevision, actor) {
      try {
        await saveWithChange(
          db,
          {
            schoolId,
            kind: "absence",
            entityId: id,
            revision: expectedRevision + 1,
            op: "delete",
            actor,
          },
          async (tx) => {
            const existing = await loadRecord(tx, schoolId, id);
            if (!existing) throw new AbsenceNotFoundError("absence", id);
            if (existing.revision !== expectedRevision) {
              throw new RevisionConflictError(absenceConflictLatest(existing));
            }
            await (tx as unknown as LooseSource)
              .delete(absences as unknown as PgTable)
              .where(and(eq(absences.schoolId, schoolId), eq(absences.id, id)));
          },
        );
      } catch (error) {
        if (error instanceof AbsenceNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapAbsenceWriteError(error, "remove");
      }
    },
  };
}

export function createAbsenceSubdivisionStore(db: Db): AbsenceSubdivisionStore {
  async function loadRecord(
    source: Db | Transaction,
    schoolId: string,
    id: string,
  ): Promise<AbsenceSubdivisionRecord | undefined> {
    const rows = (await (source as unknown as LooseSource)
      .select()
      .from(absenceSubdivisions as unknown as PgTable)
      .where(
        and(eq(absenceSubdivisions.schoolId, schoolId), eq(absenceSubdivisions.id, id)),
      )) as unknown as AbsenceSubdivisionRow[] | [];
    return rows[0] ? subdivisionToRecord(rows[0]) : undefined;
  }

  const store: AbsenceSubdivisionStore = {
    async list(schoolId) {
      const rows = await db
        .select()
        .from(absenceSubdivisions)
        .where(eq(absenceSubdivisions.schoolId, schoolId))
        .orderBy(asc(absenceSubdivisions.code), asc(absenceSubdivisions.key));
      return rows.map(subdivisionToRecord);
    },

    async get(schoolId, id) {
      return loadRecord(db, schoolId, id);
    },

    async create(input, actor) {
      try {
        return await saveWithChange(
          db,
          {
            schoolId: input.schoolId,
            kind: "absence_subdivision",
            entityId: input.id,
            revision: 1,
            op: "upsert",
            actor,
          },
          async (tx) => {
            const inserted = await (tx as unknown as LooseSource)
              .insert(absenceSubdivisions as unknown as PgTable)
              .values({
                schoolId: input.schoolId,
                id: input.id,
                code: input.code,
                key: input.key,
                label: input.label,
                revision: 1,
                updatedBy: actor.userId,
                updatedVia: actor.via,
              })
              .returning();
            return subdivisionToRecord(inserted[0] as unknown as AbsenceSubdivisionRow);
          },
        );
      } catch (error) {
        mapSubdivisionWriteError(error, "write");
      }
    },

    async update(input, actor) {
      try {
        return await saveWithChange(
          db,
          (updated: AbsenceSubdivisionRecord) => ({
            schoolId: input.schoolId,
            kind: "absence_subdivision" as const,
            entityId: input.id,
            revision: updated.revision,
            op: "upsert" as const,
            actor,
          }),
          async (tx) => {
            const existing = await loadRecord(tx, input.schoolId, input.id);
            if (!existing) throw new AbsenceNotFoundError("absence_subdivision", input.id);
            try {
              const updated = (await updateRevisioned(
                tx,
                absenceSubdivisions as unknown as RevisionedTable,
                {
                  schoolId: input.schoolId,
                  id: input.id,
                  expectedRevision: input.revision,
                  actor,
                  set: {
                    code: input.code,
                    key: input.key,
                    label: input.label,
                  } as never,
                },
              )) as unknown as AbsenceSubdivisionRow;
              return subdivisionToRecord(updated);
            } catch (error) {
              if (error instanceof RevisionConflictError) {
                throw new RevisionConflictError(existing);
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (error instanceof AbsenceNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapSubdivisionWriteError(error, "write");
      }
    },

    async remove(schoolId, id, expectedRevision, actor) {
      try {
        await saveWithChange(
          db,
          {
            schoolId,
            kind: "absence_subdivision",
            entityId: id,
            revision: expectedRevision + 1,
            op: "delete",
            actor,
          },
          async (tx) => {
            const existing = await loadRecord(tx, schoolId, id);
            if (!existing) throw new AbsenceNotFoundError("absence_subdivision", id);
            if (existing.revision !== expectedRevision) {
              throw new RevisionConflictError(existing);
            }
            await (tx as unknown as LooseSource)
              .delete(absenceSubdivisions as unknown as PgTable)
              .where(
                and(eq(absenceSubdivisions.schoolId, schoolId), eq(absenceSubdivisions.id, id)),
              );
          },
        );
      } catch (error) {
        if (error instanceof AbsenceNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapSubdivisionWriteError(error, "remove");
      }
    },

    async applyDefaults(schoolId, actor) {
      const existing = await store.list(schoolId);
      const have = new Set(existing.map((row) => `${row.code}/${row.key}`));
      const created: AbsenceSubdivisionRecord[] = [];
      for (const def of defaultLeaveSubdivisions) {
        if (have.has(`${def.code}/${def.key}`)) continue;
        created.push(
          await store.create(
            {
              schoolId,
              id: `default-${def.code}-${def.key}`,
              code: def.code,
              key: def.key,
              label: def.label,
            },
            actor,
          ),
        );
      }
      return created;
    },
  };
  return store;
}
