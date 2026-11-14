import { randomUUID } from "node:crypto";
import { and, asc, between, eq, lt } from "drizzle-orm";
import {
  addDays,
  datesInRange,
  dutyAppliesOn,
  nextRotationIndex,
  planRotation,
  weekStartOf,
  type DutyApplicablePeriod,
  type DutyDayFacts,
  type Weekday,
} from "@school-manage/calendar-types";
import type { Db } from "./client.js";
import {
  dutyAssignments,
  dutyDefinitions,
  rotationRules,
  type DutyAssignmentRow,
  type DutyDefinitionRow,
  type RotationRuleRow,
} from "./schema.js";
import type { DutyDefinitionInput } from "../duties/types.js";

/**
 * The duty store (Issue #30): duty definitions, their rotation
 * rules, and the assignments. Every query carries the school_id
 * condition (DESIGN-AUTH-TENANCY 3.3); the composite foreign keys
 * are the second line of defence. Automatic generation is a draft
 * (DESIGN schedule 4.7): applying a rotation writes only cells
 * that are empty or hold an earlier automatic assignment, and
 * never overwrites a manual or swap row.
 */

function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface DutyDefinitionWithRule extends DutyDefinitionRow {
  rotation: RotationRuleRow | null;
}

export async function getDutyDefinitions(
  db: Db,
  schoolId: string,
): Promise<DutyDefinitionWithRule[]> {
  const [definitionRows, ruleRows] = await Promise.all([
    db
      .select()
      .from(dutyDefinitions)
      .where(eq(dutyDefinitions.schoolId, schoolId))
      .orderBy(asc(dutyDefinitions.sort), asc(dutyDefinitions.id)),
    db.select().from(rotationRules).where(eq(rotationRules.schoolId, schoolId)),
  ]);
  return definitionRows.map((definition) => ({
    ...definition,
    rotation: ruleRows.find((r) => r.dutyDefinitionId === definition.id) ?? null,
  }));
}

export async function getDutyDefinition(
  db: Db,
  schoolId: string,
  id: string,
): Promise<DutyDefinitionWithRule | null> {
  const all = await getDutyDefinitions(db, schoolId);
  return all.find((d) => d.id === id) ?? null;
}

export async function upsertDutyDefinition(
  db: Db,
  schoolId: string,
  input: DutyDefinitionInput,
): Promise<DutyDefinitionWithRule> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .insert(dutyDefinitions)
        .values({
          schoolId,
          id: input.id,
          name: input.name,
          granularity: input.granularity,
          applicablePeriod: input.applicablePeriod,
          applicableStartsOn: input.applicableStartsOn ?? null,
          applicableEndsOn: input.applicableEndsOn ?? null,
          targetGroupId: input.targetGroupId ?? null,
          sort: input.sort ?? 0,
        })
        .onConflictDoUpdate({
          target: [dutyDefinitions.schoolId, dutyDefinitions.id],
          set: {
            name: input.name,
            granularity: input.granularity,
            applicablePeriod: input.applicablePeriod,
            applicableStartsOn: input.applicableStartsOn ?? null,
            applicableEndsOn: input.applicableEndsOn ?? null,
            targetGroupId: input.targetGroupId ?? null,
            sort: input.sort ?? 0,
          },
        })
        .returning();
      const definition = rows[0] as DutyDefinitionRow;
      if (input.rotation !== undefined) {
        await tx
          .delete(rotationRules)
          .where(
            and(eq(rotationRules.schoolId, schoolId), eq(rotationRules.dutyDefinitionId, input.id)),
          );
        if (input.rotation) {
          await tx.insert(rotationRules).values({
            schoolId,
            id: randomUUID(),
            dutyDefinitionId: input.id,
            personIds: input.rotation.personIds,
            changeWeekdays: input.rotation.changeWeekdays ?? null,
          });
        }
      }
      const rules = await tx
        .select()
        .from(rotationRules)
        .where(
          and(eq(rotationRules.schoolId, schoolId), eq(rotationRules.dutyDefinitionId, input.id)),
        );
      // A rotation generates assignments for people, but a duty
      // on a target group takes targets, never people (the manual
      // path refuses the same combination per cell). Reject the
      // pair here, on the definition as it would stand after this
      // save — including a rule kept from before when only the
      // target group is being set. Throwing rolls the save back.
      if (definition.targetGroupId && rules.length > 0) {
        throw new Error("a duty on a target group cannot have a rotation rule");
      }
      return { ...definition, rotation: (rules[0] as RotationRuleRow | undefined) ?? null };
    });
  } catch (error) {
    if (pgErrorCode(error) === "23503") {
      throw new Error(
        "a duty definition references a target group that does not exist in this school",
      );
    }
    throw error;
  }
}

export async function deleteDutyDefinition(db: Db, schoolId: string, id: string): Promise<boolean> {
  try {
    const rows = await db
      .delete(dutyDefinitions)
      .where(and(eq(dutyDefinitions.schoolId, schoolId), eq(dutyDefinitions.id, id)))
      .returning();
    return rows.length > 0;
  } catch (error) {
    if (pgErrorCode(error) === "23503") {
      throw new Error(`duty definition is used by a view and cannot be deleted: ${id}`);
    }
    throw error;
  }
}

export interface GetAssignmentsQuery {
  from: string;
  to: string;
  dutyDefinitionId?: string | undefined;
}

export async function getAssignments(
  db: Db,
  schoolId: string,
  query: GetAssignmentsQuery,
): Promise<DutyAssignmentRow[]> {
  const conditions = [
    eq(dutyAssignments.schoolId, schoolId),
    between(dutyAssignments.date, query.from, query.to),
  ];
  if (query.dutyDefinitionId) {
    conditions.push(eq(dutyAssignments.dutyDefinitionId, query.dutyDefinitionId));
  }
  return db
    .select()
    .from(dutyAssignments)
    .where(and(...conditions))
    .orderBy(
      asc(dutyAssignments.date),
      asc(dutyAssignments.dutyDefinitionId),
      asc(dutyAssignments.slot),
    );
}

export interface SetAssignmentEntry {
  dutyDefinitionId: string;
  date: string;
  slot: string;
  personId: string | null;
  targetId: string | null;
  note: string | null;
}

/**
 * Sets one cell by hand. A manual set over an automatic row keeps
 * the row (and its created_by) and marks it as a manual override;
 * over a manual or swap row it simply replaces the holder. Naming
 * no holder at all empties the cell but leaves a manual row with
 * no holder (the holder check allows both to be null): the cell
 * was cleared on purpose, and because a plan keeps manual rows,
 * the next automatic generation leaves it empty instead of
 * refilling it as if nobody had touched it.
 */
export async function setAssignment(
  db: Db,
  schoolId: string,
  entry: SetAssignmentEntry,
  actor: string,
): Promise<DutyAssignmentRow> {
  return db.transaction(async (tx) => {
    const cell = and(
      eq(dutyAssignments.schoolId, schoolId),
      eq(dutyAssignments.dutyDefinitionId, entry.dutyDefinitionId),
      eq(dutyAssignments.date, entry.date),
      eq(dutyAssignments.slot, entry.slot),
    );
    const existing = (await tx.select().from(dutyAssignments).where(cell))[0] as
      DutyAssignmentRow | undefined;
    if (existing) {
      const rows = await tx
        .update(dutyAssignments)
        .set({
          personId: entry.personId,
          targetId: entry.targetId,
          note: entry.note,
          origin: "manual",
          isManualOverride: existing.origin === "auto" ? true : existing.isManualOverride,
          updatedBy: actor,
          updatedAt: new Date(),
        })
        .where(cell)
        .returning();
      return rows[0] as DutyAssignmentRow;
    }
    const rows = await tx
      .insert(dutyAssignments)
      .values({
        schoolId,
        id: randomUUID(),
        dutyDefinitionId: entry.dutyDefinitionId,
        date: entry.date,
        slot: entry.slot,
        personId: entry.personId,
        targetId: entry.targetId,
        note: entry.note,
        origin: "manual",
        isManualOverride: false,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return rows[0] as DutyAssignmentRow;
  });
}

/**
 * One cell of a rotation plan. "create" fills an empty cell,
 * "replace" rewrites an earlier automatic assignment, and "keep"
 * leaves the cell exactly as it is — a manual or swap row, or an
 * automatic row already naming the planned holder.
 */
export interface RotationPlanCell {
  date: string;
  slot: string;
  personId: string;
  action: "create" | "replace" | "keep";
  existing: DutyAssignmentRow | null;
}

export interface BuildRotationPlanInput {
  definition: DutyDefinitionWithRule;
  range: { from: string; to: string };
  /** The slots each unit date gets, in display order. */
  slots: readonly string[];
  /** What the platform calendar says about a date. */
  factsOf: (date: string) => DutyDayFacts;
}

/**
 * Computes a rotation over a range without writing anything (the
 * preview; applyRotationPlan consumes the same plan). The unit
 * dates are the dates the definition is in force on; for a week
 * duty they are the week starts, the week beginning on the rule's
 * first change weekday when one is named (金曜交代), else Monday.
 * The cycle resumes after the most recent holder before the range,
 * so generating month by month continues the rotation.
 */
export async function buildRotationPlan(
  db: Db,
  schoolId: string,
  input: BuildRotationPlanInput,
): Promise<RotationPlanCell[]> {
  const { definition, range, slots, factsOf } = input;
  const rule = definition.rotation;
  if (!rule || rule.personIds.length === 0) return [];

  const periodLike = {
    applicablePeriod: definition.applicablePeriod as DutyApplicablePeriod,
    startsOn: definition.applicableStartsOn,
    endsOn: definition.applicableEndsOn,
  };
  // The first unit date: for a week duty the range can start
  // mid-week, and the first unit is that week's start, which is
  // BEFORE range.from. Every read below is aligned to this date —
  // reading existing rows from range.from would miss the week
  // row that opens the range (the plan would try to create it
  // again and hit the cell unique constraint), and the "earlier"
  // boundary must sit here too, or that opening row counts as
  // the previous holder and the rotation shifts by one.
  const weekStart = (rule.changeWeekdays?.[0] as Weekday | undefined) ?? "mon";
  const firstUnitDate =
    definition.granularity === "week" ? weekStartOf(range.from, weekStart) : range.from;
  const unitDates: string[] = [];
  if (definition.granularity === "week") {
    for (let date = firstUnitDate; date <= range.to; date = addDays(date, 7)) {
      if (dutyAppliesOn(periodLike, date, factsOf(date))) unitDates.push(date);
    }
  } else {
    for (const date of datesInRange(range.from, range.to)) {
      if (dutyAppliesOn(periodLike, date, factsOf(date))) unitDates.push(date);
    }
  }
  if (unitDates.length === 0 || slots.length === 0) return [];

  const cells = unitDates.flatMap((date) => slots.map((slot) => ({ date, slot })));

  const earlier = await db
    .select()
    .from(dutyAssignments)
    .where(
      and(
        eq(dutyAssignments.schoolId, schoolId),
        eq(dutyAssignments.dutyDefinitionId, definition.id),
        lt(dutyAssignments.date, firstUnitDate),
      ),
    )
    .orderBy(asc(dutyAssignments.date));
  const slotOrder = new Map(slots.map((slot, i) => [slot, i]));
  const lastHolder = [...earlier]
    .filter((a) => a.personId !== null)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (slotOrder.get(a.slot) ?? 99) - (slotOrder.get(b.slot) ?? 99),
    )
    .at(-1);
  const startIndex = nextRotationIndex(rule.personIds, lastHolder?.personId ?? null);

  const planned = planRotation(
    rule.personIds,
    startIndex,
    cells,
    (rule.changeWeekdays as Weekday[] | null) ?? undefined,
  );

  const existingRows = await getAssignments(db, schoolId, {
    from: firstUnitDate,
    to: range.to,
    dutyDefinitionId: definition.id,
  });
  const existingByCell = new Map(existingRows.map((r) => [`${r.date}|${r.slot}`, r]));
  return planned.map((cell) => {
    const existing = existingByCell.get(`${cell.date}|${cell.slot}`) ?? null;
    if (!existing) return { ...cell, action: "create" as const, existing };
    if (existing.origin === "auto" && existing.personId !== cell.personId) {
      return { ...cell, action: "replace" as const, existing };
    }
    return { ...cell, action: "keep" as const, existing };
  });
}

export interface ApplyRotationResult {
  created: number;
  updated: number;
  /**
   * Cells left untouched: manual / swap rows, rows already right,
   * and "replace" cells whose row stopped being automatic after
   * the plan was made (a manual set landed in between).
   */
  skipped: number;
  assignments: DutyAssignmentRow[];
}

/**
 * Writes a plan (see buildRotationPlan) in one transaction. Only
 * "create" and "replace" cells are written; a manual or swap row
 * is never overwritten (DESIGN schedule 4.7).
 */
export async function applyRotationPlan(
  db: Db,
  schoolId: string,
  definitionId: string,
  plan: readonly RotationPlanCell[],
  actor: string,
): Promise<ApplyRotationResult> {
  return db.transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const assignments: DutyAssignmentRow[] = [];
    for (const cell of plan) {
      if (cell.action === "keep") {
        skipped += 1;
        if (cell.existing) assignments.push(cell.existing);
        continue;
      }
      if (cell.action === "create") {
        const rows = await tx
          .insert(dutyAssignments)
          .values({
            schoolId,
            id: randomUUID(),
            dutyDefinitionId: definitionId,
            date: cell.date,
            slot: cell.slot,
            personId: cell.personId,
            targetId: null,
            note: null,
            origin: "auto",
            isManualOverride: false,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning();
        created += 1;
        assignments.push(rows[0] as DutyAssignmentRow);
        continue;
      }
      // The plan was computed outside this transaction: a manual
      // set may have landed on the cell in between. The update
      // only reaches rows that are still automatic — if it
      // matches nothing, the cell is counted as skipped and the
      // manual row is left exactly as it is.
      const rows = await tx
        .update(dutyAssignments)
        .set({ personId: cell.personId, updatedBy: actor, updatedAt: new Date() })
        .where(
          and(
            eq(dutyAssignments.schoolId, schoolId),
            eq(dutyAssignments.dutyDefinitionId, definitionId),
            eq(dutyAssignments.date, cell.date),
            eq(dutyAssignments.slot, cell.slot),
            eq(dutyAssignments.origin, "auto"),
          ),
        )
        .returning();
      if (rows.length === 0) {
        skipped += 1;
        continue;
      }
      updated += 1;
      assignments.push(rows[0] as DutyAssignmentRow);
    }
    return { created, updated, skipped, assignments };
  });
}
