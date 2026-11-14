import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AbsenceKind } from "@school-manage/calendar-types";
import type { Db } from "./client.js";
import {
  dutyAssignments,
  dutyChanges,
  dutyConflictWaivers,
  schoolSettings,
  type DutyAssignmentRow,
  type DutyChangeRow,
  type DutyConflictWaiverRow,
} from "./schema.js";

/**
 * Duty changes and conflict waivers (Issue #31, DESIGN schedule
 * 4.7.1 / 4.7.2). A change is a recorded operation, not an edit:
 * it is proposed first (a Viewer may propose one for their own
 * assignment), and applying it rewrites the assignment(s) and the
 * change row in one transaction, so a swap can never land on one
 * side only. Conflicts themselves are derived, never stored (see
 * deriveDutyConflicts in @school-manage/calendar-types); the only
 * conflict state kept here is the waiver — the record that a
 * person saw a conflict and chose to leave it, with a reason.
 */

/** A database handle or an open transaction over one. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function getAssignmentById(
  db: DbOrTx,
  schoolId: string,
  id: string,
): Promise<DutyAssignmentRow | null> {
  const rows = await db
    .select()
    .from(dutyAssignments)
    .where(and(eq(dutyAssignments.schoolId, schoolId), eq(dutyAssignments.id, id)));
  return (rows[0] as DutyAssignmentRow | undefined) ?? null;
}

export interface ProposeDutyChangeEntry {
  kind: "swap" | "substitute" | "reassign";
  assignmentAId: string;
  assignmentBId?: string | null;
  toPersonId?: string | null;
  reason?: string | undefined;
}

/**
 * Records a proposed change. The from / to holders are read from
 * the assignments as they stand: for a swap, the two holders
 * exchange; for a substitute or reassignment, the named person
 * takes over. A swap is only between two assignments of the same
 * duty (the prototype's rule), and never of an assignment with
 * itself.
 */
export async function proposeChange(
  db: Db,
  schoolId: string,
  entry: ProposeDutyChangeEntry,
  requestedBy: string,
): Promise<DutyChangeRow> {
  const a = await getAssignmentById(db, schoolId, entry.assignmentAId);
  if (!a) {
    throw new Error(`duty assignment not found: ${entry.assignmentAId}`);
  }
  let assignmentBId: string | null = null;
  let toPersonId: string | null;
  if (entry.kind === "swap") {
    if (!entry.assignmentBId) {
      throw new Error("a swap needs the other assignment (assignmentBId)");
    }
    if (entry.assignmentBId === a.id) {
      throw new Error("an assignment cannot be swapped with itself");
    }
    const b = await getAssignmentById(db, schoolId, entry.assignmentBId);
    if (!b) {
      throw new Error(`duty assignment not found: ${entry.assignmentBId}`);
    }
    if (b.dutyDefinitionId !== a.dutyDefinitionId) {
      throw new Error("a swap is only between assignments of the same duty");
    }
    assignmentBId = b.id;
    toPersonId = b.personId;
  } else {
    if (!entry.toPersonId) {
      throw new Error(`a ${entry.kind} needs the person who takes over (toPersonId)`);
    }
    toPersonId = entry.toPersonId;
  }
  const rows = await db
    .insert(dutyChanges)
    .values({
      schoolId,
      id: randomUUID(),
      dutyDefinitionId: a.dutyDefinitionId,
      kind: entry.kind,
      assignmentAId: a.id,
      assignmentBId,
      fromPersonId: a.personId,
      toPersonId,
      reason: entry.reason ?? "",
      requestedBy,
      status: "proposed",
    })
    .returning();
  return rows[0] as DutyChangeRow;
}

async function loadProposedChange(
  db: DbOrTx,
  schoolId: string,
  id: string,
): Promise<DutyChangeRow> {
  const rows = await db
    .select()
    .from(dutyChanges)
    .where(and(eq(dutyChanges.schoolId, schoolId), eq(dutyChanges.id, id)));
  const change = rows[0] as DutyChangeRow | undefined;
  if (!change) {
    throw new Error(`duty change not found: ${id}`);
  }
  if (change.status !== "proposed") {
    throw new Error(`duty change is not proposed (status: ${change.status}): ${id}`);
  }
  return change;
}

/**
 * Applies a proposed change in one transaction: the assignment(s)
 * and the change row move together, or not at all — if either
 * assignment has disappeared since the proposal, everything rolls
 * back and the proposal stands. A swap exchanges the assignments'
 * holders as they stand at apply time (and the change row's
 * from / to are refreshed to what was actually exchanged); a
 * substitute or reassignment installs the person named in the
 * proposal. Touched assignments get origin "swap", so later
 * automatic generation never overwrites them (DESIGN schedule
 * 4.7).
 */
export async function applyChange(
  db: Db,
  schoolId: string,
  id: string,
  actor: string,
): Promise<DutyChangeRow> {
  return db.transaction(async (tx) => {
    const change = await loadProposedChange(tx, schoolId, id);
    const a = await getAssignmentById(tx, schoolId, change.assignmentAId);
    if (!a) {
      throw new Error(`duty assignment not found: ${change.assignmentAId}`);
    }
    const now = new Date();
    let fromPersonId = change.fromPersonId;
    let toPersonId = change.toPersonId;
    if (change.kind === "swap") {
      if (!change.assignmentBId) {
        throw new Error(`duty change has no swap partner: ${id}`);
      }
      const b = await getAssignmentById(tx, schoolId, change.assignmentBId);
      if (!b) {
        throw new Error(`duty assignment not found: ${change.assignmentBId}`);
      }
      fromPersonId = a.personId;
      toPersonId = b.personId;
      await tx
        .update(dutyAssignments)
        .set({ personId: b.personId, origin: "swap", updatedBy: actor, updatedAt: now })
        .where(and(eq(dutyAssignments.schoolId, schoolId), eq(dutyAssignments.id, a.id)));
      await tx
        .update(dutyAssignments)
        .set({ personId: a.personId, origin: "swap", updatedBy: actor, updatedAt: now })
        .where(and(eq(dutyAssignments.schoolId, schoolId), eq(dutyAssignments.id, b.id)));
    } else {
      await tx
        .update(dutyAssignments)
        .set({ personId: change.toPersonId, origin: "swap", updatedBy: actor, updatedAt: now })
        .where(and(eq(dutyAssignments.schoolId, schoolId), eq(dutyAssignments.id, a.id)));
    }
    const rows = await tx
      .update(dutyChanges)
      .set({
        status: "applied",
        approvedBy: actor,
        appliedAt: now,
        fromPersonId,
        toPersonId,
      })
      .where(and(eq(dutyChanges.schoolId, schoolId), eq(dutyChanges.id, id)))
      .returning();
    return rows[0] as DutyChangeRow;
  });
}

/**
 * Declines a proposed change: the assignments are not touched.
 * approved_by records who decided (DESIGN-AUTH-TENANCY 4.7 names
 * the column for the decider, on a decline as on an apply).
 */
export async function declineChange(
  db: Db,
  schoolId: string,
  id: string,
  actor: string,
): Promise<DutyChangeRow> {
  return db.transaction(async (tx) => {
    await loadProposedChange(tx, schoolId, id);
    const rows = await tx
      .update(dutyChanges)
      .set({ status: "declined", approvedBy: actor })
      .where(and(eq(dutyChanges.schoolId, schoolId), eq(dutyChanges.id, id)))
      .returning();
    return rows[0] as DutyChangeRow;
  });
}

export async function listChanges(
  db: Db,
  schoolId: string,
  dutyDefinitionId?: string,
): Promise<DutyChangeRow[]> {
  const conditions = [eq(dutyChanges.schoolId, schoolId)];
  if (dutyDefinitionId) {
    conditions.push(eq(dutyChanges.dutyDefinitionId, dutyDefinitionId));
  }
  return db
    .select()
    .from(dutyChanges)
    .where(and(...conditions))
    .orderBy(desc(dutyChanges.createdAt), desc(dutyChanges.id));
}

export interface WaiveConflictEntry {
  assignmentId: string;
  /** A platform absence id (no foreign key exists to check). */
  absenceId: string;
  reason?: string | undefined;
}

/**
 * Records (or re-records, updating the reason) that an assignment
 * × absence conflict was reviewed and is intentionally left as it
 * is. The assignment must be this school's; the absence is the
 * platform's to know about, and a waiver naming a since-deleted
 * absence simply never matches a derived conflict again.
 */
export async function waiveConflict(
  db: Db,
  schoolId: string,
  entry: WaiveConflictEntry,
  waivedBy: string,
): Promise<DutyConflictWaiverRow> {
  const assignment = await getAssignmentById(db, schoolId, entry.assignmentId);
  if (!assignment) {
    throw new Error(`duty assignment not found: ${entry.assignmentId}`);
  }
  const rows = await db
    .insert(dutyConflictWaivers)
    .values({
      schoolId,
      id: randomUUID(),
      assignmentId: entry.assignmentId,
      absenceId: entry.absenceId,
      waivedBy,
      reason: entry.reason ?? "",
    })
    .onConflictDoUpdate({
      target: [
        dutyConflictWaivers.schoolId,
        dutyConflictWaivers.assignmentId,
        dutyConflictWaivers.absenceId,
      ],
      set: { waivedBy, reason: entry.reason ?? "", updatedAt: new Date() },
    })
    .returning();
  return rows[0] as DutyConflictWaiverRow;
}

export async function listWaivers(db: Db, schoolId: string): Promise<DutyConflictWaiverRow[]> {
  return db
    .select()
    .from(dutyConflictWaivers)
    .where(eq(dutyConflictWaivers.schoolId, schoolId))
    .orderBy(desc(dutyConflictWaivers.createdAt), desc(dutyConflictWaivers.id));
}

/**
 * The absence kinds this school counts for duty-conflict
 * detection, from its settings row: null when the school has not
 * chosen (every kind counts).
 */
export async function getConflictAbsenceKinds(
  db: Db,
  schoolId: string,
): Promise<AbsenceKind[] | null> {
  const rows = await db.select().from(schoolSettings).where(eq(schoolSettings.schoolId, schoolId));
  const kinds = rows[0]?.dutyConflictAbsenceKinds;
  return kinds ? (kinds as AbsenceKind[]) : null;
}
