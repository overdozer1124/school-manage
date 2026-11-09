import { randomUUID } from "node:crypto";
import { and, eq, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type {
  ChangeEntityKind,
  ChangeEvent,
  DayPattern,
  DayPatternRecord,
  Grade,
  GradeRecord,
  SchoolClass,
  SchoolClassRecord,
  SpecialNeedsClass,
  SpecialNeedsClassRecord,
  StaffMember,
  StaffMemberRecord,
} from "@school-manage/calendar-types";
import {
  RevisionConflictError,
  saveWithChange,
  updateRevisioned,
  type RevisionedTable,
} from "./changes.js";
import type { Db } from "./client.js";
import {
  classes,
  dayPatternPeriods,
  dayPatterns,
  grades,
  specialNeedsClasses,
  staffMembers,
  type ClassRow,
  type DayPatternPeriodRow,
  type DayPatternRow,
  type GradeRow,
  type SpecialNeedsClassRow,
  type StaffRow,
} from "./schema.js";

/**
 * The shared masters store (Issue #22, DESIGN-INTEGRATION 2.4 / 3.1).
 * Every write goes through the #21 helpers, so the master row and its
 * outbox event commit together, and updates are guarded by the
 * revision optimistic lock. Reads are scoped to one school; a master
 * of another school is indistinguishable from a missing one.
 */

type Actor = ChangeEvent["actor"];
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The master does not exist in this school (the routes answer 404). */
export class MasterNotFoundError extends Error {
  constructor(kind: ChangeEntityKind, id: string) {
    super(`master not found: ${kind}/${id}`);
    this.name = "MasterNotFoundError";
  }
}

/**
 * The write conflicts with the current state: the id is already in
 * use, or other data still references the master (the routes answer
 * 409; a stale revision is RevisionConflictError, also 409).
 */
export class MasterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterConflictError";
  }
}

/**
 * The write points at a master that is not in this school — a class
 * naming another school's grade, a staff row naming a person who does
 * not exist (the routes answer 400).
 */
export class MasterReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterReferenceError";
  }
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/** Maps the database's constraint answers onto the store's errors. */
function mapWriteError(error: unknown, context: "write" | "remove", kind: ChangeEntityKind): never {
  const code = pgCode(error);
  if (code === "23505") {
    throw new MasterConflictError(`a ${kind} with this id already exists in this school`);
  }
  if (code === "23503") {
    if (context === "remove") {
      throw new MasterConflictError(`this ${kind} is still referenced by other data`);
    }
    throw new MasterReferenceError(`this ${kind} references data that is not in this school`);
  }
  throw error;
}

export interface MasterCrud<M, R> {
  list(schoolId: string): Promise<R[]>;
  get(schoolId: string, id: string): Promise<R | undefined>;
  create(input: M, actor: Actor): Promise<R>;
  update(input: M & { revision: number }, actor: Actor): Promise<R>;
  remove(schoolId: string, id: string, expectedRevision: number, actor: Actor): Promise<void>;
}

export interface MasterStore {
  staff: MasterCrud<StaffMember, StaffMemberRecord>;
  grades: MasterCrud<Grade, GradeRecord>;
  classes: MasterCrud<SchoolClass, SchoolClassRecord>;
  specialNeedsClasses: MasterCrud<SpecialNeedsClass, SpecialNeedsClassRecord>;
  dayPatterns: MasterCrud<DayPattern, DayPatternRecord>;
}

/**
 * The generic table typing is erased at this single point, as in
 * changes.ts: each kind's public surface is fully typed, and the
 * runtime calls are the ordinary drizzle builders (a bare generic
 * table type is rejected by drizzle's insert/update).
 */
interface LooseDb {
  select(): {
    from(table: PgTable): {
      where(cond: SQL | undefined): Promise<Record<string, unknown>[]>;
    };
  };
  insert(table: PgTable): {
    values(values: Record<string, unknown>): { returning(): Promise<Record<string, unknown>[]> };
  };
  delete(table: PgTable): {
    where(cond: SQL | undefined): Promise<unknown>;
  };
}

interface SimpleSpec<M, R> {
  kind: ChangeEntityKind;
  table: RevisionedTable;
  sortKey(row: Record<string, unknown>): [number, string];
  insertValues(input: M, actor: Actor): Record<string, unknown>;
  updateSet(input: M): Record<string, unknown>;
  toRecord(row: Record<string, unknown>): R;
}

function metaOf(row: Record<string, unknown>) {
  return {
    revision: row.revision as number,
    updatedBy: row.updatedBy as string,
    updatedVia: row.updatedVia as "platform" | "schedule" | "timetable",
  };
}

function makeSimpleCrud<M, R>(db: Db, spec: SimpleSpec<M, R>): MasterCrud<M, R> {
  const table = spec.table;
  const looseDb = db as unknown as LooseDb;

  async function findRow(schoolId: string, id: string, tx?: Transaction) {
    const source = (tx ?? looseDb) as unknown as LooseDb;
    const rows = await source
      .select()
      .from(table)
      .where(and(eq(table.schoolId, schoolId), eq(table.id, id)));
    return rows[0];
  }

  return {
    async list(schoolId) {
      const rows = await looseDb.select().from(table).where(eq(table.schoolId, schoolId));
      return rows
        .map((row) => spec.toRecord(row))
        .sort((a, b) => {
          const ka = spec.sortKey(a as Record<string, unknown>);
          const kb = spec.sortKey(b as Record<string, unknown>);
          return ka[0] - kb[0] || ka[1].localeCompare(kb[1]);
        });
    },

    async get(schoolId, id) {
      const row = await findRow(schoolId, id);
      return row ? spec.toRecord(row) : undefined;
    },

    async create(input, actor) {
      try {
        const row = await saveWithChange(
          db,
          {
            schoolId: (input as unknown as { schoolId: string }).schoolId,
            kind: spec.kind,
            entityId: (input as unknown as { id: string }).id,
            revision: 1,
            op: "upsert",
            actor,
          },
          async (tx) => {
            const inserted = await (tx as unknown as LooseDb)
              .insert(table)
              .values(spec.insertValues(input, actor))
              .returning();
            return inserted[0] as Record<string, unknown>;
          },
        );
        return spec.toRecord(row);
      } catch (error) {
        mapWriteError(error, "write", spec.kind);
      }
    },

    async update(input, actor) {
      const schoolId = (input as unknown as { schoolId: string }).schoolId;
      const id = (input as unknown as { id: string }).id;
      try {
        const row = await saveWithChange(
          db,
          (updated: Record<string, unknown>) => ({
            schoolId,
            kind: spec.kind,
            entityId: id,
            revision: updated.revision as number,
            op: "upsert",
            actor,
          }),
          async (tx) => {
            if (!(await findRow(schoolId, id, tx))) {
              throw new MasterNotFoundError(spec.kind, id);
            }
            const updated = await updateRevisioned(tx, table, {
              schoolId,
              id,
              expectedRevision: input.revision,
              actor,
              set: spec.updateSet(input) as never,
            });
            return updated as unknown as Record<string, unknown>;
          },
        );
        return spec.toRecord(row);
      } catch (error) {
        if (error instanceof MasterNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapWriteError(error, "write", spec.kind);
      }
    },

    async remove(schoolId, id, expectedRevision, actor) {
      try {
        await saveWithChange(
          db,
          {
            schoolId,
            kind: spec.kind,
            entityId: id,
            revision: expectedRevision + 1,
            op: "delete",
            actor,
          },
          async (tx) => {
            const row = await findRow(schoolId, id, tx);
            if (!row) throw new MasterNotFoundError(spec.kind, id);
            if ((row.revision as number) !== expectedRevision) {
              throw new RevisionConflictError(spec.toRecord(row));
            }
            await (tx as unknown as LooseDb)
              .delete(table)
              .where(and(eq(table.schoolId, schoolId), eq(table.id, id)));
          },
        );
      } catch (error) {
        if (error instanceof MasterNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapWriteError(error, "remove", spec.kind);
      }
    },
  };
}

const bySortOrder = (row: Record<string, unknown>): [number, string] => [
  row.sortOrder as number,
  row.id as string,
];

export function createMasterStore(db: Db): MasterStore {
  const staff = makeSimpleCrud<StaffMember, StaffMemberRecord>(db, {
    kind: "staff",
    table: staffMembers as unknown as RevisionedTable,
    sortKey: bySortOrder,
    insertValues: (input, actor) => ({
      schoolId: input.schoolId,
      id: input.id,
      name: input.name,
      shortName: input.shortName,
      sortOrder: input.sortOrder,
      active: input.active,
      personId: input.personId,
      revision: 1,
      updatedBy: actor.userId,
      updatedVia: actor.via,
    }),
    updateSet: (input) => ({
      name: input.name,
      shortName: input.shortName,
      sortOrder: input.sortOrder,
      active: input.active,
      personId: input.personId,
    }),
    toRecord: (row) => {
      const r = row as unknown as StaffRow;
      return {
        schoolId: r.schoolId,
        id: r.id,
        name: r.name,
        shortName: r.shortName,
        sortOrder: r.sortOrder,
        active: r.active,
        personId: r.personId,
        ...metaOf(row),
      };
    },
  });

  const gradesCrud = makeSimpleCrud<Grade, GradeRecord>(db, {
    kind: "grade",
    table: grades as unknown as RevisionedTable,
    sortKey: bySortOrder,
    insertValues: (input, actor) => ({
      schoolId: input.schoolId,
      id: input.id,
      name: input.name,
      sortOrder: input.sortOrder,
      stage: input.stage,
      revision: 1,
      updatedBy: actor.userId,
      updatedVia: actor.via,
    }),
    updateSet: (input) => ({
      name: input.name,
      sortOrder: input.sortOrder,
      stage: input.stage,
    }),
    toRecord: (row) => {
      const r = row as unknown as GradeRow;
      return {
        schoolId: r.schoolId,
        id: r.id,
        name: r.name,
        sortOrder: r.sortOrder,
        stage: r.stage,
        ...metaOf(row),
      };
    },
  });

  const classesCrud = makeSimpleCrud<SchoolClass, SchoolClassRecord>(db, {
    kind: "class",
    table: classes as unknown as RevisionedTable,
    sortKey: bySortOrder,
    insertValues: (input, actor) => ({
      schoolId: input.schoolId,
      id: input.id,
      gradeId: input.gradeId,
      name: input.name,
      sortOrder: input.sortOrder,
      revision: 1,
      updatedBy: actor.userId,
      updatedVia: actor.via,
    }),
    updateSet: (input) => ({
      gradeId: input.gradeId,
      name: input.name,
      sortOrder: input.sortOrder,
    }),
    toRecord: (row) => {
      const r = row as unknown as ClassRow;
      return {
        schoolId: r.schoolId,
        id: r.id,
        gradeId: r.gradeId,
        name: r.name,
        sortOrder: r.sortOrder,
        ...metaOf(row),
      };
    },
  });

  const specialCrud = makeSimpleCrud<SpecialNeedsClass, SpecialNeedsClassRecord>(db, {
    kind: "special_needs_class",
    table: specialNeedsClasses as unknown as RevisionedTable,
    sortKey: bySortOrder,
    insertValues: (input, actor) => ({
      schoolId: input.schoolId,
      id: input.id,
      name: input.name,
      sortOrder: input.sortOrder,
      revision: 1,
      updatedBy: actor.userId,
      updatedVia: actor.via,
    }),
    updateSet: (input) => ({
      name: input.name,
      sortOrder: input.sortOrder,
    }),
    toRecord: (row) => {
      const r = row as unknown as SpecialNeedsClassRow;
      return {
        schoolId: r.schoolId,
        id: r.id,
        name: r.name,
        sortOrder: r.sortOrder,
        ...metaOf(row),
      };
    },
  });

  const dayPatternsCrud: MasterCrud<DayPattern, DayPatternRecord> = {
    async list(schoolId) {
      const patterns = await db
        .select()
        .from(dayPatterns)
        .where(eq(dayPatterns.schoolId, schoolId));
      const periods = await db
        .select()
        .from(dayPatternPeriods)
        .where(eq(dayPatternPeriods.schoolId, schoolId));
      return patterns
        .map((pattern) => toDayPatternRecord(pattern, periods))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    },

    async get(schoolId, id) {
      const pattern = await findPattern(db, schoolId, id);
      if (!pattern) return undefined;
      const periods = await db
        .select()
        .from(dayPatternPeriods)
        .where(
          and(eq(dayPatternPeriods.schoolId, schoolId), eq(dayPatternPeriods.dayPatternId, id)),
        );
      return toDayPatternRecord(pattern, periods);
    },

    async create(input, actor) {
      try {
        return await saveWithChange(
          db,
          {
            schoolId: input.schoolId,
            kind: "day_pattern",
            entityId: input.id,
            revision: 1,
            op: "upsert",
            actor,
          },
          async (tx) => {
            const inserted = await tx
              .insert(dayPatterns)
              .values({
                schoolId: input.schoolId,
                id: input.id,
                kind: input.kind,
                name: input.name,
                revision: 1,
                updatedBy: actor.userId,
                updatedVia: actor.via,
              })
              .returning();
            await insertPeriods(tx, input);
            return toDayPatternRecord(inserted[0] as DayPatternRow, periodRowsOf(input));
          },
        );
      } catch (error) {
        mapWriteError(error, "write", "day_pattern");
      }
    },

    async update(input, actor) {
      try {
        return await saveWithChange(
          db,
          (updated: DayPatternRecord) => ({
            schoolId: input.schoolId,
            kind: "day_pattern" as const,
            entityId: input.id,
            revision: updated.revision,
            op: "upsert" as const,
            actor,
          }),
          async (tx) => {
            if (!(await findPattern(tx, input.schoolId, input.id))) {
              throw new MasterNotFoundError("day_pattern", input.id);
            }
            const updated = await updateRevisioned(tx, dayPatterns as unknown as RevisionedTable, {
              schoolId: input.schoolId,
              id: input.id,
              expectedRevision: input.revision,
              actor,
              set: { kind: input.kind, name: input.name } as never,
            });
            // Periods are subordinate rows: replace the whole set
            // under the pattern's new revision.
            await tx
              .delete(dayPatternPeriods)
              .where(
                and(
                  eq(dayPatternPeriods.schoolId, input.schoolId),
                  eq(dayPatternPeriods.dayPatternId, input.id),
                ),
              );
            await insertPeriods(tx, input);
            return toDayPatternRecord(updated as DayPatternRow, periodRowsOf(input));
          },
        );
      } catch (error) {
        if (error instanceof MasterNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapWriteError(error, "write", "day_pattern");
      }
    },

    async remove(schoolId, id, expectedRevision, actor) {
      try {
        await saveWithChange(
          db,
          {
            schoolId,
            kind: "day_pattern",
            entityId: id,
            revision: expectedRevision + 1,
            op: "delete",
            actor,
          },
          async (tx) => {
            const pattern = await findPattern(tx, schoolId, id);
            if (!pattern) throw new MasterNotFoundError("day_pattern", id);
            if (pattern.revision !== expectedRevision) {
              const periods = await tx
                .select()
                .from(dayPatternPeriods)
                .where(
                  and(
                    eq(dayPatternPeriods.schoolId, schoolId),
                    eq(dayPatternPeriods.dayPatternId, id),
                  ),
                );
              throw new RevisionConflictError(toDayPatternRecord(pattern, periods));
            }
            await tx
              .delete(dayPatternPeriods)
              .where(
                and(
                  eq(dayPatternPeriods.schoolId, schoolId),
                  eq(dayPatternPeriods.dayPatternId, id),
                ),
              );
            await tx
              .delete(dayPatterns)
              .where(and(eq(dayPatterns.schoolId, schoolId), eq(dayPatterns.id, id)));
          },
        );
      } catch (error) {
        if (error instanceof MasterNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapWriteError(error, "remove", "day_pattern");
      }
    },
  };

  return {
    staff,
    grades: gradesCrud,
    classes: classesCrud,
    specialNeedsClasses: specialCrud,
    dayPatterns: dayPatternsCrud,
  };
}

type DbOrTx = Db | Transaction;

async function findPattern(source: DbOrTx, schoolId: string, id: string) {
  const rows = await source
    .select()
    .from(dayPatterns)
    .where(and(eq(dayPatterns.schoolId, schoolId), eq(dayPatterns.id, id)));
  return rows[0];
}

function periodRowsOf(input: DayPattern): DayPatternPeriodRow[] {
  return input.periods.map((p) => ({
    schoolId: input.schoolId,
    id: "",
    dayPatternId: input.id,
    period: p.period,
    label: p.label,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
  }));
}

async function insertPeriods(tx: Transaction, input: DayPattern) {
  if (input.periods.length === 0) return;
  await tx.insert(dayPatternPeriods).values(
    input.periods.map((p) => ({
      schoolId: input.schoolId,
      id: randomUUID(),
      dayPatternId: input.id,
      period: p.period,
      label: p.label,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
    })),
  );
}

function toDayPatternRecord(
  pattern: DayPatternRow,
  periods: DayPatternPeriodRow[],
): DayPatternRecord {
  return {
    schoolId: pattern.schoolId,
    id: pattern.id,
    name: pattern.name,
    kind: pattern.kind as DayPatternRecord["kind"],
    periods: periods
      .filter((p) => p.dayPatternId === pattern.id)
      .sort((a, b) => a.period - b.period)
      .map((p) => ({
        period: p.period,
        label: p.label,
        startsAt: p.startsAt as DayPatternRecord["periods"][number]["startsAt"],
        endsAt: p.endsAt as DayPatternRecord["periods"][number]["endsAt"],
      })),
    revision: pattern.revision,
    updatedBy: pattern.updatedBy,
    updatedVia: pattern.updatedVia,
  };
}
