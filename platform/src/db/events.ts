import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  eventInRange,
  filterVisible,
  forAudience,
  isVisibleTo,
  type Audience,
  type CalendarEventInput,
  type CalendarEventRecord,
  type ChangeEvent,
  type EventAssignee,
  type EventImpact,
  type TargetRef,
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
  eventAssignees,
  eventImpacts,
  eventTargets,
  events,
  grades,
  specialNeedsClasses,
  staffMembers,
  type EventAssigneeRow,
  type EventImpactRow,
  type EventRow,
  type EventTargetRow,
} from "./schema.js";

/**
 * The school calendar's events store (Issue #24, DESIGN-INTEGRATION
 * 2.2 / 6, schedule DESIGN 4.5). Every write goes through the #21
 * helpers, so the event rows and their outbox event commit together,
 * and updates are guarded by the revision optimistic lock. Reads are
 * scoped to one school and filtered for the caller's audience with
 * the shared pure functions (calendar-types audience.ts): the server
 * never hands a non-staff audience an event it may not see, nor any
 * assignee name (DESIGN-AUTH-TENANCY 4.5).
 */

type Actor = ChangeEvent["actor"];
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The event does not exist in this school (the routes answer 404). */
export class EventNotFoundError extends Error {
  constructor(id: string) {
    super(`event not found: ${id}`);
    this.name = "EventNotFoundError";
  }
}

/** The write conflicts with the current state (the routes answer 409). */
export class EventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventConflictError";
  }
}

/**
 * The write points at a target or staff member that is not in this
 * school (the routes answer 400).
 */
export class EventReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventReferenceError";
  }
}

/**
 * What a 409 answer may carry about the current event (standing
 * carry-over from the earlier issues: RevisionConflictError.latest is
 * filtered for privacy before it goes into a response body). Only the
 * fields a client needs to show "someone else changed this" are here:
 * no assignees, no description, no location text, no targets or
 * impacts.
 */
export interface EventConflictLatest {
  id: string;
  revision: number;
  title: string;
  kind: CalendarEventRecord["kind"];
  datePrecision: CalendarEventRecord["datePrecision"];
  startsOn: string | null;
  endsOn: string | null;
  certainty: CalendarEventRecord["certainty"];
  visibility: CalendarEventRecord["visibility"];
  updatedBy: string;
  updatedVia: CalendarEventRecord["updatedVia"];
}

export function eventConflictLatest(record: CalendarEventRecord): EventConflictLatest {
  return {
    id: record.id,
    revision: record.revision,
    title: record.title,
    kind: record.kind,
    datePrecision: record.datePrecision,
    startsOn: record.startsOn,
    endsOn: record.endsOn,
    certainty: record.certainty,
    visibility: record.visibility,
    updatedBy: record.updatedBy,
    updatedVia: record.updatedVia,
  };
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/** Maps the database's constraint answers onto the store's errors. */
function mapWriteError(error: unknown, context: "write" | "remove"): never {
  const code = pgCode(error);
  if (code === "23505") {
    throw new EventConflictError("an event with the same id already exists in this school");
  }
  if (code === "23503") {
    if (context === "remove") {
      throw new EventConflictError("this event is still referenced by other data");
    }
    throw new EventReferenceError("this event references data that is not in this school");
  }
  throw error;
}

export interface EventStore {
  /**
   * The school's events that belong in [from, to] and that the
   * audience may see, redacted for the audience. Month-precision
   * events match their month and undecided events match the full
   * school-year range of their own year (calendar-types
   * eventInRange; the range is also applied in SQL, see
   * rangeCondition).
   */
  listRange(
    schoolId: string,
    range: { from: string; to: string },
    audience: Audience,
  ): Promise<CalendarEventRecord[]>;
  /** One event for an audience, or undefined when it does not exist
   *  in this school — or when the audience may not see it (the two
   *  are indistinguishable on purpose). */
  get(schoolId: string, id: string, audience: Audience): Promise<CalendarEventRecord | undefined>;
  create(input: CalendarEventInput, actor: Actor): Promise<CalendarEventRecord>;
  update(
    input: CalendarEventInput & { revision: number },
    actor: Actor,
  ): Promise<CalendarEventRecord>;
  remove(schoolId: string, id: string, expectedRevision: number, actor: Actor): Promise<void>;
}

/**
 * The generic table typing is erased at this single point, as in
 * masters.ts: the public surface above is fully typed, and the
 * runtime calls are the ordinary drizzle builders.
 */
interface LooseSource {
  select(): {
    from(table: PgTable): {
      where(cond: SQL | undefined): Promise<Record<string, unknown>[]>;
    };
  };
  insert(table: PgTable): {
    values(values: Record<string, unknown> | Record<string, unknown>[]): {
      returning(): Promise<Record<string, unknown>[]>;
    };
  };
  delete(table: PgTable): {
    where(cond: SQL | undefined): Promise<unknown>;
  };
}

/** The shared-master tables a TargetRef axis can point at. The "room"
 *  axis has no master table in the platform — rooms live in the
 *  schedule app's location master (Issue #27) — so, like the "app"
 *  axis, a room reference is stored without an existence check, the
 *  same treatment the event's location_id gets. */
const TARGET_TABLES = {
  grade: grades,
  class: classes,
  special_needs_class: specialNeedsClasses,
  staff: staffMembers,
} as const;

type MasterAxis = keyof typeof TARGET_TABLES;

function masterTargetsOf(targets: readonly TargetRef[]): Map<MasterAxis, string[]> {
  const byAxis = new Map<MasterAxis, string[]>();
  for (const target of targets) {
    if (target.axis === "app" || target.axis === "room") continue;
    const ids = byAxis.get(target.axis) ?? [];
    ids.push(target.id);
    byAxis.set(target.axis, ids);
  }
  return byAxis;
}

/**
 * Refuses targets and assignees that are not this school's
 * (DESIGN-INTEGRATION 8-1-3, Issue #24): shared-master targets are
 * checked for existence in the school, app-axis targets are stored
 * unchecked, and a staff assignee must be a staff member of the
 * school. The composite foreign keys are the second line of defence.
 */
interface MasterTableLike {
  schoolId: PgColumn;
  id: PgColumn;
}

async function assertOwnedIds(
  source: LooseSource,
  table: MasterTableLike,
  schoolId: string,
  ids: readonly string[],
  what: string,
): Promise<void> {
  const rows = await source
    .select()
    .from(table as unknown as PgTable)
    .where(and(eq(table.schoolId, schoolId), inArray(table.id, [...new Set(ids)])));
  const owned = new Set(rows.map((r) => r.id as string));
  const missing = [...new Set(ids.filter((id) => !owned.has(id)))];
  if (missing.length > 0) {
    throw new EventReferenceError(`${what} not in this school: ${missing.join(", ")}`);
  }
}

async function assertReferences(
  source: LooseSource,
  schoolId: string,
  input: CalendarEventInput,
): Promise<void> {
  const targets: TargetRef[] = [
    ...input.targets,
    ...input.impacts.flatMap((impact) => (impact.kind === "block_periods" ? impact.targets : [])),
  ];
  for (const [axis, ids] of masterTargetsOf(targets)) {
    await assertOwnedIds(
      source,
      TARGET_TABLES[axis] as unknown as MasterTableLike,
      schoolId,
      ids,
      `targets (${axis})`,
    );
  }
  const staffIds = input.assignees.flatMap((a) => (a.kind === "staff" ? [a.staffId] : []));
  if (staffIds.length > 0) {
    await assertOwnedIds(
      source,
      staffMembers as unknown as MasterTableLike,
      schoolId,
      staffIds,
      "assignees (staff)",
    );
  }
}

interface Children {
  impacts: EventImpactRow[];
  targets: EventTargetRow[];
  assignees: EventAssigneeRow[];
}

/** The children a write carries, in row shape (ids are assigned at
 *  insert time; toRecord only reads eventId / position / payload). */
function childrenOf(input: CalendarEventInput): Children {
  return {
    impacts: input.impacts.map((impact, position) => ({
      schoolId: input.schoolId,
      id: "",
      eventId: input.id,
      position,
      impact,
    })),
    targets: input.targets.map((target, position) => ({
      schoolId: input.schoolId,
      id: "",
      eventId: input.id,
      position,
      target,
    })),
    assignees: input.assignees.map((assignee, position) => ({
      schoolId: input.schoolId,
      id: "",
      eventId: input.id,
      position,
      staffId: assignee.kind === "staff" ? assignee.staffId : null,
      freeTextName: assignee.kind === "free_text" ? assignee.name : null,
      role: assignee.role,
    })),
  };
}

function toRecord(row: EventRow, children: Children): CalendarEventRecord {
  const impacts = children.impacts
    .filter((c) => c.eventId === row.id)
    .sort((a, b) => a.position - b.position)
    .map((c) => c.impact as EventImpact);
  const targets = children.targets
    .filter((c) => c.eventId === row.id)
    .sort((a, b) => a.position - b.position)
    .map((c) => c.target as TargetRef);
  const assignees = children.assignees
    .filter((c) => c.eventId === row.id)
    .sort((a, b) => a.position - b.position)
    .map((c): EventAssignee =>
      c.staffId !== null
        ? { kind: "staff", staffId: c.staffId, role: c.role }
        : { kind: "free_text", name: c.freeTextName as string, role: c.role },
    );
  return {
    schoolId: row.schoolId,
    id: row.id,
    revision: row.revision,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    updatedVia: row.updatedVia,
    title: row.title,
    kind: row.kind as CalendarEventRecord["kind"],
    kindLabel: row.kindLabel,
    datePrecision: row.datePrecision as CalendarEventRecord["datePrecision"],
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    time: row.time as CalendarEventRecord["time"],
    locationId: row.locationId,
    locationText: row.locationText,
    description: row.description,
    certainty: row.certainty as CalendarEventRecord["certainty"],
    visibility: row.visibility as CalendarEventRecord["visibility"],
    targets,
    impacts,
    assignees,
  };
}

/**
 * The SQL form of calendar-types' eventInRange, so a range read does
 * not load every event the school has ever had (review recommendation
 * on PR #57). Day / range events overlap by their stored dates; a
 * month event overlaps by its whole month; an undecided event matches
 * only when the range covers its whole school year (its startsOn is
 * April 1 of that year). listRange still applies eventInRange in JS
 * afterwards, so the two definitions cannot drift apart observably.
 */
function rangeCondition(range: { from: string; to: string }): SQL {
  return sql`(
    (${events.datePrecision} in ('day', 'range')
      and ${events.startsOn} <= ${range.to}::date
      and coalesce(${events.endsOn}, ${events.startsOn}) >= ${range.from}::date)
    or (${events.datePrecision} = 'month'
      and date_trunc('month', ${events.startsOn})::date <= ${range.to}::date
      and (date_trunc('month', ${events.startsOn}) + interval '1 month - 1 day')::date >= ${range.from}::date)
    or (${events.datePrecision} = 'undecided'
      and ${range.from}::date <= ${events.startsOn}
      and (${events.startsOn} + interval '1 year - 1 day')::date <= ${range.to}::date)
  )`;
}

export function createEventStore(db: Db): EventStore {
  async function loadRecords(
    source: Db | Transaction,
    schoolId: string,
    onlyId?: string,
    range?: { from: string; to: string },
  ): Promise<CalendarEventRecord[]> {
    const eventRows = (await (source as unknown as LooseSource)
      .select()
      .from(events as unknown as PgTable)
      .where(
        onlyId
          ? and(eq(events.schoolId, schoolId), eq(events.id, onlyId))
          : range
            ? and(eq(events.schoolId, schoolId), rangeCondition(range))
            : eq(events.schoolId, schoolId),
      )) as unknown as EventRow[];
    if (eventRows.length === 0) return [];
    const ids = eventRows.map((r) => r.id);
    const childWhere = and(eq(eventImpacts.schoolId, schoolId), inArray(eventImpacts.eventId, ids));
    const [impactRows, targetRows, assigneeRows] = await Promise.all([
      (source as unknown as LooseSource)
        .select()
        .from(eventImpacts as unknown as PgTable)
        .where(childWhere) as Promise<EventImpactRow[]>,
      (source as unknown as LooseSource)
        .select()
        .from(eventTargets as unknown as PgTable)
        .where(
          and(eq(eventTargets.schoolId, schoolId), inArray(eventTargets.eventId, ids)),
        ) as Promise<EventTargetRow[]>,
      (source as unknown as LooseSource)
        .select()
        .from(eventAssignees as unknown as PgTable)
        .where(
          and(eq(eventAssignees.schoolId, schoolId), inArray(eventAssignees.eventId, ids)),
        ) as Promise<EventAssigneeRow[]>,
    ]);
    const children: Children = {
      impacts: impactRows,
      targets: targetRows,
      assignees: assigneeRows,
    };
    return eventRows.map((row) => toRecord(row, children));
  }

  async function insertChildren(tx: Transaction, input: CalendarEventInput): Promise<void> {
    const loose = tx as unknown as LooseSource;
    if (input.impacts.length > 0) {
      await loose.insert(eventImpacts as unknown as PgTable).values(
        input.impacts.map((impact, position) => ({
          schoolId: input.schoolId,
          id: randomUUID(),
          eventId: input.id,
          position,
          impact,
        })),
      );
    }
    if (input.targets.length > 0) {
      await loose.insert(eventTargets as unknown as PgTable).values(
        input.targets.map((target, position) => ({
          schoolId: input.schoolId,
          id: randomUUID(),
          eventId: input.id,
          position,
          target,
        })),
      );
    }
    if (input.assignees.length > 0) {
      await loose.insert(eventAssignees as unknown as PgTable).values(
        input.assignees.map((assignee, position) => ({
          schoolId: input.schoolId,
          id: randomUUID(),
          eventId: input.id,
          position,
          staffId: assignee.kind === "staff" ? assignee.staffId : null,
          freeTextName: assignee.kind === "free_text" ? assignee.name : null,
          role: assignee.role,
        })),
      );
    }
  }

  async function deleteChildren(tx: Transaction, schoolId: string, eventId: string): Promise<void> {
    const loose = tx as unknown as LooseSource;
    for (const table of [eventImpacts, eventTargets, eventAssignees]) {
      await loose
        .delete(table as unknown as PgTable)
        .where(and(eq(table.schoolId, schoolId), eq(table.eventId, eventId)));
    }
  }

  return {
    async listRange(schoolId, range, audience) {
      const records = await loadRecords(db, schoolId, undefined, range);
      return filterVisible(
        records.filter((record) => eventInRange(record, range.from, range.to)),
        audience,
      )
        .sort(
          (a, b) =>
            (a.startsOn ?? "9999-99-99").localeCompare(b.startsOn ?? "9999-99-99") ||
            a.title.localeCompare(b.title) ||
            a.id.localeCompare(b.id),
        )
        .map((record) => forAudience(record, audience));
    },

    async get(schoolId, id, audience) {
      const records = await loadRecords(db, schoolId, id);
      const record = records[0];
      if (!record || !isVisibleTo(record.visibility, audience)) return undefined;
      return forAudience(record, audience);
    },

    async create(input, actor) {
      try {
        return await saveWithChange(
          db,
          {
            schoolId: input.schoolId,
            kind: "event",
            entityId: input.id,
            revision: 1,
            op: "upsert",
            actor,
          },
          async (tx) => {
            await assertReferences(tx as unknown as LooseSource, input.schoolId, input);
            const inserted = await (tx as unknown as LooseSource)
              .insert(events as unknown as PgTable)
              .values({
                schoolId: input.schoolId,
                id: input.id,
                title: input.title,
                kind: input.kind,
                kindLabel: input.kindLabel,
                datePrecision: input.datePrecision,
                startsOn: input.startsOn,
                endsOn: input.endsOn,
                time: input.time,
                locationId: input.locationId,
                locationText: input.locationText,
                description: input.description,
                certainty: input.certainty,
                visibility: input.visibility,
                revision: 1,
                createdBy: actor.userId,
                updatedBy: actor.userId,
                updatedVia: actor.via,
              })
              .returning();
            await insertChildren(tx, input);
            const children = childrenOf(input);
            return toRecord(inserted[0] as unknown as EventRow, children);
          },
        );
      } catch (error) {
        if (error instanceof EventReferenceError) throw error;
        mapWriteError(error, "write");
      }
    },

    async update(input, actor) {
      try {
        return await saveWithChange(
          db,
          (updated: CalendarEventRecord) => ({
            schoolId: input.schoolId,
            kind: "event" as const,
            entityId: input.id,
            revision: updated.revision,
            op: "upsert" as const,
            actor,
          }),
          async (tx) => {
            const existing = await loadRecords(tx, input.schoolId, input.id);
            if (!existing[0]) throw new EventNotFoundError(input.id);
            await assertReferences(tx as unknown as LooseSource, input.schoolId, input);
            let updated: EventRow;
            try {
              updated = (await updateRevisioned(tx, events as unknown as RevisionedTable, {
                schoolId: input.schoolId,
                id: input.id,
                expectedRevision: input.revision,
                actor,
                set: {
                  title: input.title,
                  kind: input.kind,
                  kindLabel: input.kindLabel,
                  datePrecision: input.datePrecision,
                  startsOn: input.startsOn,
                  endsOn: input.endsOn,
                  time: input.time,
                  locationId: input.locationId,
                  locationText: input.locationText,
                  description: input.description,
                  certainty: input.certainty,
                  visibility: input.visibility,
                } as never,
              })) as unknown as EventRow;
            } catch (error) {
              if (error instanceof RevisionConflictError) {
                // Replace the raw row the helper carries with the
                // privacy-filtered summary before it can reach a
                // response body.
                throw new RevisionConflictError(eventConflictLatest(existing[0]));
              }
              throw error;
            }
            await deleteChildren(tx, input.schoolId, input.id);
            await insertChildren(tx, input);
            const children = childrenOf(input);
            return toRecord(updated, children);
          },
        );
      } catch (error) {
        if (
          error instanceof EventNotFoundError ||
          error instanceof EventReferenceError ||
          error instanceof RevisionConflictError
        ) {
          throw error;
        }
        mapWriteError(error, "write");
      }
    },

    async remove(schoolId, id, expectedRevision, actor) {
      try {
        await saveWithChange(
          db,
          {
            schoolId,
            kind: "event",
            entityId: id,
            revision: expectedRevision + 1,
            op: "delete",
            actor,
          },
          async (tx) => {
            const existing = await loadRecords(tx, schoolId, id);
            const record = existing[0];
            if (!record) throw new EventNotFoundError(id);
            if (record.revision !== expectedRevision) {
              throw new RevisionConflictError(eventConflictLatest(record));
            }
            await deleteChildren(tx, schoolId, id);
            await (tx as unknown as LooseSource)
              .delete(events as unknown as PgTable)
              .where(and(eq(events.schoolId, schoolId), eq(events.id, id)));
          },
        );
      } catch (error) {
        if (error instanceof EventNotFoundError || error instanceof RevisionConflictError) {
          throw error;
        }
        mapWriteError(error, "remove");
      }
    },
  };
}
