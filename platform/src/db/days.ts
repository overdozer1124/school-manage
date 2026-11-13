import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type {
  CalendarDay,
  CalendarDayInput,
  ChangeEvent,
  Holiday,
  HolidayInput,
} from "@school-manage/calendar-types";
import {
  RevisionConflictError,
  saveWithChange,
  updateRevisioned,
  type RevisionedTable,
} from "./changes.js";
import type { Db } from "./client.js";
import { dayPatterns, dayRecords, holidays, type DayRecordRow, type HolidayRow } from "./schema.js";

/**
 * The school calendar's day and holiday stores (Issue #23,
 * DESIGN-INTEGRATION 2.1 / 6, schedule DESIGN 4.1). The day records
 * say what kind of day each date is; the holidays are the separate
 * official list of holidays and closed days. Every write goes
 * through the #21 helpers, so the row and its outbox event commit
 * together, and updates are guarded by the revision optimistic lock.
 * Reads are scoped to one school.
 *
 * Only recorded days exist here: a date with no day record is the
 * default day (a class day on a weekday, a closed day on a weekend),
 * which readers derive from the weekday (calendar-types time.ts) —
 * the store returns the rows a school has, nothing synthesized.
 *
 * Days and holidays carry no private fields, so a 409 may carry the
 * full current record as `latest` (the masters' precedent; events
 * filter theirs because they carry assignee names and the like).
 */

type Actor = ChangeEvent["actor"];
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type CalendarEntryKind = "day" | "holiday";

/** The day or holiday does not exist in this school (404). */
export class CalendarEntryNotFoundError extends Error {
  constructor(
    readonly entryKind: CalendarEntryKind,
    id: string,
  ) {
    super(`${entryKind} not found: ${id}`);
    this.name = "CalendarEntryNotFoundError";
  }
}

/** The write conflicts with the current state (409). */
export class CalendarEntryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarEntryConflictError";
  }
}

/**
 * The write points at data that is not in this school (400) — for a
 * day, a day pattern of another school, or one that does not exist.
 */
export class CalendarEntryReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarEntryReferenceError";
  }
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

function pgConstraint(error: unknown): string | undefined {
  const e = error as {
    constraint_name?: string;
    cause?: { constraint_name?: string };
  } | null;
  return e?.constraint_name ?? e?.cause?.constraint_name;
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

function dayToRecord(row: DayRecordRow): CalendarDay {
  return {
    schoolId: row.schoolId,
    id: row.id,
    revision: row.revision,
    updatedBy: row.updatedBy,
    updatedVia: row.updatedVia,
    date: row.date,
    dayType: row.dayType as CalendarDay["dayType"],
    dayTypeLabel: row.dayTypeLabel,
    dayScheduleId: row.dayScheduleId,
    weekdaySwap: row.weekdaySwap as CalendarDay["weekdaySwap"],
    note: row.note,
  };
}

function holidayToRecord(row: HolidayRow): Holiday {
  return {
    schoolId: row.schoolId,
    id: row.id,
    revision: row.revision,
    updatedBy: row.updatedBy,
    updatedVia: row.updatedVia,
    date: row.date,
    name: row.name,
    kind: row.kind as Holiday["kind"],
  };
}

export interface DayStore {
  /** The school's recorded days in [from, to], by date. Days with no
   *  record are not synthesized (see the module comment). */
  listRange(schoolId: string, range: { from: string; to: string }): Promise<CalendarDay[]>;
  /** One recorded day, or undefined when the school has none by that id. */
  get(schoolId: string, id: string): Promise<CalendarDay | undefined>;
  create(input: CalendarDayInput, actor: Actor): Promise<CalendarDay>;
  update(input: CalendarDayInput & { revision: number }, actor: Actor): Promise<CalendarDay>;
  remove(schoolId: string, id: string, expectedRevision: number, actor: Actor): Promise<void>;
}

export interface HolidayStore {
  /** The school's holidays in [from, to], by date. */
  listRange(schoolId: string, range: { from: string; to: string }): Promise<Holiday[]>;
  /** One holiday, or undefined when the school has none by that id. */
  get(schoolId: string, id: string): Promise<Holiday | undefined>;
  create(input: HolidayInput, actor: Actor): Promise<Holiday>;
  update(input: HolidayInput & { revision: number }, actor: Actor): Promise<Holiday>;
  remove(schoolId: string, id: string, expectedRevision: number, actor: Actor): Promise<void>;
}

/**
 * Refuses a day pattern that is not this school's (Issue #23's
 * completion condition: another school's pattern cannot be named).
 * The composite foreign key on (school_id, day_schedule_id) is the
 * second line of defence, the same arrangement masters.ts uses for
 * its cross-table references.
 */
async function assertDayPattern(
  source: LooseSource,
  schoolId: string,
  dayScheduleId: string | null,
): Promise<void> {
  if (dayScheduleId === null) return;
  const rows = await source
    .select()
    .from(dayPatterns as unknown as PgTable)
    .where(and(eq(dayPatterns.schoolId, schoolId), eq(dayPatterns.id, dayScheduleId)));
  if (rows.length === 0) {
    throw new CalendarEntryReferenceError(`day pattern not in this school: ${dayScheduleId}`);
  }
}

function mapDayWriteError(error: unknown, context: "write" | "remove"): never {
  const code = pgCode(error);
  if (code === "23505") {
    if (pgConstraint(error) === "day_records_school_date_unique") {
      throw new CalendarEntryConflictError("a day is already recorded for that date");
    }
    throw new CalendarEntryConflictError("a day with the same id already exists in this school");
  }
  if (code === "23503") {
    if (context === "remove") {
      throw new CalendarEntryConflictError("this day is still referenced by other data");
    }
    throw new CalendarEntryReferenceError("this day references data that is not in this school");
  }
  throw error;
}

function mapHolidayWriteError(error: unknown, context: "write" | "remove"): never {
  const code = pgCode(error);
  if (code === "23505") {
    if (pgConstraint(error) === "holidays_school_date_kind_unique") {
      throw new CalendarEntryConflictError(
        "a holiday of the same kind is already recorded for that date",
      );
    }
    throw new CalendarEntryConflictError(
      "a holiday with the same id already exists in this school",
    );
  }
  if (code === "23503" && context === "remove") {
    throw new CalendarEntryConflictError("this holiday is still referenced by other data");
  }
  throw error;
}

export function createDayStore(db: Db): DayStore {
  async function loadRecord(
    source: Db | Transaction,
    schoolId: string,
    id: string,
  ): Promise<CalendarDay | undefined> {
    const rows = (await (source as unknown as LooseSource)
      .select()
      .from(dayRecords as unknown as PgTable)
      .where(and(eq(dayRecords.schoolId, schoolId), eq(dayRecords.id, id)))) as unknown as
      DayRecordRow[] | [];
    return rows[0] ? dayToRecord(rows[0]) : undefined;
  }

  return {
    async listRange(schoolId, range) {
      const rows = await db
        .select()
        .from(dayRecords)
        .where(
          and(
            eq(dayRecords.schoolId, schoolId),
            gte(dayRecords.date, range.from),
            lte(dayRecords.date, range.to),
          ),
        )
        .orderBy(asc(dayRecords.date), asc(dayRecords.id));
      return rows.map(dayToRecord);
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
            kind: "day",
            entityId: input.id,
            revision: 1,
            op: "upsert",
            actor,
          },
          async (tx) => {
            await assertDayPattern(
              tx as unknown as LooseSource,
              input.schoolId,
              input.dayScheduleId,
            );
            const inserted = await (tx as unknown as LooseSource)
              .insert(dayRecords as unknown as PgTable)
              .values({
                schoolId: input.schoolId,
                id: input.id,
                date: input.date,
                dayType: input.dayType,
                dayTypeLabel: input.dayTypeLabel,
                dayScheduleId: input.dayScheduleId,
                weekdaySwap: input.weekdaySwap,
                note: input.note,
                revision: 1,
                updatedBy: actor.userId,
                updatedVia: actor.via,
              })
              .returning();
            return dayToRecord(inserted[0] as unknown as DayRecordRow);
          },
        );
      } catch (error) {
        if (error instanceof CalendarEntryReferenceError) throw error;
        mapDayWriteError(error, "write");
      }
    },

    async update(input, actor) {
      try {
        return await saveWithChange(
          db,
          (updated: CalendarDay) => ({
            schoolId: input.schoolId,
            kind: "day" as const,
            entityId: input.id,
            revision: updated.revision,
            op: "upsert" as const,
            actor,
          }),
          async (tx) => {
            const existing = await loadRecord(tx, input.schoolId, input.id);
            if (!existing) throw new CalendarEntryNotFoundError("day", input.id);
            await assertDayPattern(
              tx as unknown as LooseSource,
              input.schoolId,
              input.dayScheduleId,
            );
            try {
              const updated = (await updateRevisioned(
                tx,
                dayRecords as unknown as RevisionedTable,
                {
                  schoolId: input.schoolId,
                  id: input.id,
                  expectedRevision: input.revision,
                  actor,
                  set: {
                    date: input.date,
                    dayType: input.dayType,
                    dayTypeLabel: input.dayTypeLabel,
                    dayScheduleId: input.dayScheduleId,
                    weekdaySwap: input.weekdaySwap,
                    note: input.note,
                  } as never,
                },
              )) as unknown as DayRecordRow;
              return dayToRecord(updated);
            } catch (error) {
              if (error instanceof RevisionConflictError) {
                throw new RevisionConflictError(existing);
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (
          error instanceof CalendarEntryNotFoundError ||
          error instanceof CalendarEntryReferenceError ||
          error instanceof RevisionConflictError
        ) {
          throw error;
        }
        mapDayWriteError(error, "write");
      }
    },

    async remove(schoolId, id, expectedRevision, actor) {
      try {
        await saveWithChange(
          db,
          {
            schoolId,
            kind: "day",
            entityId: id,
            revision: expectedRevision + 1,
            op: "delete",
            actor,
          },
          async (tx) => {
            const existing = await loadRecord(tx, schoolId, id);
            if (!existing) throw new CalendarEntryNotFoundError("day", id);
            if (existing.revision !== expectedRevision) {
              throw new RevisionConflictError(existing);
            }
            await (tx as unknown as LooseSource)
              .delete(dayRecords as unknown as PgTable)
              .where(and(eq(dayRecords.schoolId, schoolId), eq(dayRecords.id, id)));
          },
        );
      } catch (error) {
        if (error instanceof CalendarEntryNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapDayWriteError(error, "remove");
      }
    },
  };
}

export function createHolidayStore(db: Db): HolidayStore {
  async function loadRecord(
    source: Db | Transaction,
    schoolId: string,
    id: string,
  ): Promise<Holiday | undefined> {
    const rows = (await (source as unknown as LooseSource)
      .select()
      .from(holidays as unknown as PgTable)
      .where(and(eq(holidays.schoolId, schoolId), eq(holidays.id, id)))) as unknown as
      HolidayRow[] | [];
    return rows[0] ? holidayToRecord(rows[0]) : undefined;
  }

  return {
    async listRange(schoolId, range) {
      const rows = await db
        .select()
        .from(holidays)
        .where(
          and(
            eq(holidays.schoolId, schoolId),
            gte(holidays.date, range.from),
            lte(holidays.date, range.to),
          ),
        )
        .orderBy(asc(holidays.date), asc(holidays.id));
      return rows.map(holidayToRecord);
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
            kind: "holiday",
            entityId: input.id,
            revision: 1,
            op: "upsert",
            actor,
          },
          async (tx) => {
            const inserted = await (tx as unknown as LooseSource)
              .insert(holidays as unknown as PgTable)
              .values({
                schoolId: input.schoolId,
                id: input.id,
                date: input.date,
                name: input.name,
                kind: input.kind,
                revision: 1,
                updatedBy: actor.userId,
                updatedVia: actor.via,
              })
              .returning();
            return holidayToRecord(inserted[0] as unknown as HolidayRow);
          },
        );
      } catch (error) {
        mapHolidayWriteError(error, "write");
      }
    },

    async update(input, actor) {
      try {
        return await saveWithChange(
          db,
          (updated: Holiday) => ({
            schoolId: input.schoolId,
            kind: "holiday" as const,
            entityId: input.id,
            revision: updated.revision,
            op: "upsert" as const,
            actor,
          }),
          async (tx) => {
            const existing = await loadRecord(tx, input.schoolId, input.id);
            if (!existing) throw new CalendarEntryNotFoundError("holiday", input.id);
            try {
              const updated = (await updateRevisioned(tx, holidays as unknown as RevisionedTable, {
                schoolId: input.schoolId,
                id: input.id,
                expectedRevision: input.revision,
                actor,
                set: {
                  date: input.date,
                  name: input.name,
                  kind: input.kind,
                } as never,
              })) as unknown as HolidayRow;
              return holidayToRecord(updated);
            } catch (error) {
              if (error instanceof RevisionConflictError) {
                throw new RevisionConflictError(existing);
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (error instanceof CalendarEntryNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapHolidayWriteError(error, "write");
      }
    },

    async remove(schoolId, id, expectedRevision, actor) {
      try {
        await saveWithChange(
          db,
          {
            schoolId,
            kind: "holiday",
            entityId: id,
            revision: expectedRevision + 1,
            op: "delete",
            actor,
          },
          async (tx) => {
            const existing = await loadRecord(tx, schoolId, id);
            if (!existing) throw new CalendarEntryNotFoundError("holiday", id);
            if (existing.revision !== expectedRevision) {
              throw new RevisionConflictError(existing);
            }
            await (tx as unknown as LooseSource)
              .delete(holidays as unknown as PgTable)
              .where(and(eq(holidays.schoolId, schoolId), eq(holidays.id, id)));
          },
        );
      } catch (error) {
        if (error instanceof CalendarEntryNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapHolidayWriteError(error, "remove");
      }
    },
  };
}
