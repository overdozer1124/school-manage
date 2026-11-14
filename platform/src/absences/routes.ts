import { Router, type Request, type Response } from "express";
import {
  absenceInputSchema,
  absencePublicSchema,
  absenceRestrictedSchema,
  absenceSchema,
  absenceSubdivisionInputSchema,
  absenceSubdivisionRecordSchema,
  canViewAbsenceSubdivision,
  canViewAbsenceTexts,
  isOwnAbsence,
  isValidDateString,
  type Absence,
  type AbsenceInput,
  type AbsenceSubdivisionInput,
  type AbsenceViewer,
  type Certainty,
} from "@school-manage/calendar-types";
import type { AuthConfig } from "../auth/config.js";
import { AuthError } from "../auth/errors.js";
import { requireMember, requireWriter, type AuthedMember } from "../auth/guards.js";
import type { AuthStore } from "../db/authStore.js";
import {
  AbsenceConflictError,
  AbsenceNotFoundError,
  AbsenceReferenceError,
  type AbsenceStore,
  type AbsenceSubdivisionStore,
} from "../db/absences.js";
import { RevisionConflictError } from "../db/changes.js";
import type { Membership, Product } from "../db/schema.js";

/**
 * The staff absences API (Issue #25, DESIGN-INTEGRATION 2.3,
 * DESIGN-AUTH-TENANCY 4.5 / 4.6):
 * /platform/api/v1/calendar/absences and
 * /platform/api/v1/calendar/absence-subdivisions.
 *
 * Absences are staff-only data: every endpoint first requires a
 * current membership of the session's school, so a non-staff reader
 * never receives one at all. What a member may do then splits by
 * role （連携5 as the guards define it):
 * - Editor or more in either product: register, edit and confirm
 *   anyone's absence, and maintain the subdivision definitions.
 * - Any other approved member: register and edit only their own
 *   absences — "own" by the membership's teacher_id
 *   (DESIGN-INTEGRATION 10) — and the save is always tentative; an
 *   edit of a confirmed absence returns it to tentative (4.6).
 *
 * The subdivision (the leave classification) is private (4.5): a
 * read answers with the full record only for an Admin of the school
 * or the person the absence is about, and with the public shape —
 * which has no subdivision field — for everyone else. A leave
 * absence's purpose and note are private under the same judgment
 * (the Issue #25 follow-up): for everyone else a leave answers with
 * the restricted shape, which has neither the subdivision nor the
 * texts. Other kinds keep their texts in the public shape.
 *
 * The write-check endpoint answers the write judgment for one
 * existing absence — the same rule a PUT runs — without writing
 * anything, for the schedule server's values-only saves (Issue #29).
 */
export interface AbsencesRouterDeps {
  config: AuthConfig;
  authStore: AuthStore;
  absenceStore: AbsenceStore;
  subdivisionStore: AbsenceSubdivisionStore;
}

function bodyObject(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AuthError(400, "入力が正しくありません");
  }
  return body as Record<string, unknown>;
}

/** The session's school is authoritative; a body naming another school is refused. */
function withSchool(body: Record<string, unknown>, schoolId: string): Record<string, unknown> {
  if (body.schoolId !== undefined && body.schoolId !== schoolId) {
    throw new AuthError(400, "入力が正しくありません");
  }
  return { ...body, schoolId };
}

function parseAbsenceInput(candidate: Record<string, unknown>): AbsenceInput {
  const parsed = absenceInputSchema.safeParse(candidate);
  if (!parsed.success) throw new AuthError(400, "入力が正しくありません");
  return parsed.data;
}

function parseSubdivisionInput(candidate: Record<string, unknown>): AbsenceSubdivisionInput {
  const parsed = absenceSubdivisionInputSchema.safeParse(candidate);
  if (!parsed.success) throw new AuthError(400, "入力が正しくありません");
  return parsed.data;
}

function parseRevision(body: Record<string, unknown>): number {
  const revision = body.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new AuthError(400, "入力が正しくありません");
  }
  return revision;
}

function parseRange(req: Request): { from: string; to: string } {
  const from = req.query.from;
  const to = req.query.to;
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    !isValidDateString(from) ||
    !isValidDateString(to) ||
    to < from
  ) {
    throw new AuthError(400, "入力が正しくありません");
  }
  return { from, to };
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof AbsenceNotFoundError) {
    res.status(404).json({ error: "見つかりません" });
    return;
  }
  if (error instanceof RevisionConflictError) {
    // For an absence, error.latest was already filtered to the
    // privacy-safe fields by the store (see absenceConflictLatest);
    // a subdivision definition carries no private fields, so its
    // full record may go out, as with the calendar days.
    res.status(409).json({ error: "ほかの人が先に変更しました", latest: error.latest });
    return;
  }
  if (error instanceof AbsenceConflictError) {
    res.status(409).json({ error: "その操作は現在の状態と競合します" });
    return;
  }
  if (error instanceof AbsenceReferenceError) {
    res.status(400).json({ error: "参照先が同じ学校にありません" });
    return;
  }
  res.status(500).json({ error: "サーバーエラーが発生しました" });
}

interface RoleFlags {
  isWriter: boolean;
  isAdmin: boolean;
}

/** The caller's standing in this school: Editor or more in either
 *  product is a writer （連携5, the requireWriter rule), Admin in
 *  either product is an admin. Computed from the roles directly —
 *  unlike the guards this never throws, so a route can apply the
 *  self-service rule to members who are not writers. */
async function roleFlags(authStore: AuthStore, membershipId: string): Promise<RoleFlags> {
  const flags: RoleFlags = { isWriter: false, isAdmin: false };
  const products: Product[] = ["schedule", "timetable"];
  for (const product of products) {
    const role = await authStore.findProductRole(membershipId, product);
    if (role?.role === "Admin") {
      flags.isAdmin = true;
      flags.isWriter = true;
    } else if (role?.role === "Editor") {
      flags.isWriter = true;
    }
  }
  return flags;
}

function viewerOf(membership: Membership, flags: RoleFlags): AbsenceViewer {
  return { teacherId: membership.teacherId, isAdmin: flags.isAdmin };
}

/**
 * The response body for one absence, shaped for its reader (4.5).
 * Every answer that carries an absence — reads, the pending list,
 * and the answers to a create, an update and a confirm, whose caller
 * need not be the person the absence is about — goes through here,
 * so the shaping cannot be bypassed by writing instead of reading.
 */
function readResponse(record: Absence, viewer: AbsenceViewer): unknown {
  if (canViewAbsenceSubdivision(record, viewer)) return absenceSchema.parse(record);
  return canViewAbsenceTexts(record, viewer)
    ? absencePublicSchema.parse(record)
    : absenceRestrictedSchema.parse(record);
}

/**
 * What a save by this caller stores. A writer's input certainty is
 * honored; anyone else's save is always tentative (4.6) — the input
 * may ask for "confirmed", and it is stored as tentative all the
 * same.
 */
function storedCertainty(input: AbsenceInput, flags: RoleFlags): Certainty {
  return flags.isWriter ? input.certainty : "tentative";
}

/** Refuses a non-writer's save that is not about themselves. */
function assertSelfService(input: AbsenceInput, authed: AuthedMember, flags: RoleFlags): void {
  if (flags.isWriter) return;
  if (!isOwnAbsence(input, authed.membership.teacherId)) {
    throw new AuthError(403, "権限がありません");
  }
}

/**
 * Whether this caller may write this existing absence: a writer may
 * write anyone's; anyone else only their own. This is the record
 * half of the PUT rule, shared with the write-check endpoint below
 * so the judgment the schedule server asks for (before it saves a
 * record's additional items alone, Issue #29) can never drift from
 * the judgment a real save runs.
 */
function canWriteAbsence(existing: Absence, authed: AuthedMember, flags: RoleFlags): boolean {
  return flags.isWriter || isOwnAbsence(existing, authed.membership.teacherId);
}

/**
 * The stored values a full-replace update keeps for the fields its
 * caller may not see. The input schema requires every field, but a
 * caller who was never shown a field — the subdivision for anyone
 * but an Admin and the person, a leave's purpose and note under the
 * same judgment — cannot name its value: leaving the key out would
 * refuse the edit with a 400, and sending null would silently clear
 * what is stored. So whatever the body carries for such a field is
 * ignored and the stored value is carried over instead; a caller
 * who may see the field replaces it as before.
 */
function carriedFields(existing: Absence, viewer: AbsenceViewer): Partial<AbsenceInput> {
  const carried: Partial<AbsenceInput> = {};
  if (!canViewAbsenceSubdivision(existing, viewer)) {
    carried.subdivisionKey = existing.subdivisionKey;
  }
  if (!canViewAbsenceTexts(existing, viewer)) {
    carried.purpose = existing.purpose;
    carried.note = existing.note;
  }
  return carried;
}

export function createAbsencesRouter(deps: AbsencesRouterDeps): Router {
  const router = Router();
  const absences = "/calendar/absences";
  const subdivisions = "/calendar/absence-subdivisions";

  // --- The school's subdivision definitions -------------------------

  router.get(subdivisions, async (req, res) => {
    try {
      const { claims } = await requireMember(deps, req);
      const items = await deps.subdivisionStore.list(claims.schoolId);
      res.json({ items: items.map((item) => absenceSubdivisionRecordSchema.parse(item)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(`${subdivisions}/apply-defaults`, async (req, res) => {
    try {
      const { claims } = await requireWriter(deps, req);
      const created = await deps.subdivisionStore.applyDefaults(claims.schoolId, {
        userId: claims.personId,
        via: "platform",
      });
      res.status(201).json({
        items: created.map((item) => absenceSubdivisionRecordSchema.parse(item)),
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(subdivisions, async (req, res) => {
    try {
      const { claims } = await requireWriter(deps, req);
      const input = parseSubdivisionInput(withSchool(bodyObject(req), claims.schoolId));
      const created = await deps.subdivisionStore.create(input, {
        userId: claims.personId,
        via: "platform",
      });
      res.status(201).json(absenceSubdivisionRecordSchema.parse(created));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put(`${subdivisions}/:id`, async (req, res) => {
    try {
      const { claims } = await requireWriter(deps, req);
      const id = req.params.id as string;
      const body = bodyObject(req);
      if (body.id !== undefined && body.id !== id) {
        throw new AuthError(400, "入力が正しくありません");
      }
      const revision = parseRevision(body);
      const input = parseSubdivisionInput(withSchool({ ...body, id }, claims.schoolId));
      const updated = await deps.subdivisionStore.update(
        { ...input, revision },
        { userId: claims.personId, via: "platform" },
      );
      res.json(absenceSubdivisionRecordSchema.parse(updated));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete(`${subdivisions}/:id`, async (req, res) => {
    try {
      const { claims } = await requireWriter(deps, req);
      const revision = parseRevision(bodyObject(req));
      await deps.subdivisionStore.remove(claims.schoolId, req.params.id as string, revision, {
        userId: claims.personId,
        via: "platform",
      });
      res.status(204).end();
    } catch (error) {
      handleError(res, error);
    }
  });

  // --- Absences ------------------------------------------------------

  // The confirmation queue （確認待ち一覧, 4.6) is the editors' work
  // list, so it is writers-only; registered before /:id on purpose.
  router.get(`${absences}/pending`, async (req, res) => {
    try {
      const authed = await requireWriter(deps, req);
      const flags = await roleFlags(deps.authStore, authed.membership.id);
      const viewer = viewerOf(authed.membership, flags);
      const items = await deps.absenceStore.listPending(authed.claims.schoolId);
      res.json({ items: items.map((item) => readResponse(item, viewer)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(absences, async (req, res) => {
    try {
      const authed = await requireMember(deps, req);
      const range = parseRange(req);
      const flags = await roleFlags(deps.authStore, authed.membership.id);
      const viewer = viewerOf(authed.membership, flags);
      const items = await deps.absenceStore.listRange(authed.claims.schoolId, range);
      res.json({ items: items.map((item) => readResponse(item, viewer)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(`${absences}/:id`, async (req, res) => {
    try {
      const authed = await requireMember(deps, req);
      const id = req.params.id as string;
      const item = await deps.absenceStore.get(authed.claims.schoolId, id);
      if (!item) throw new AbsenceNotFoundError("absence", id);
      const flags = await roleFlags(deps.authStore, authed.membership.id);
      res.json(readResponse(item, viewerOf(authed.membership, flags)));
    } catch (error) {
      handleError(res, error);
    }
  });

  // The write judgment for one existing absence, asked by the
  // schedule server before it saves that absence's additional items
  // alone (setEventValues, Issue #29): the same canWriteAbsence the
  // PUT runs — a writer anyone's, anyone else only their own.
  // Nothing is written and no record body is returned.
  router.get(`${absences}/:id/write-check`, async (req, res) => {
    try {
      const authed = await requireMember(deps, req);
      const id = req.params.id as string;
      const item = await deps.absenceStore.get(authed.claims.schoolId, id);
      if (!item) throw new AbsenceNotFoundError("absence", id);
      const flags = await roleFlags(deps.authStore, authed.membership.id);
      if (!canWriteAbsence(item, authed, flags)) {
        throw new AuthError(403, "権限がありません");
      }
      res.json({ writable: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(absences, async (req, res) => {
    try {
      const authed = await requireMember(deps, req);
      const input = parseAbsenceInput(withSchool(bodyObject(req), authed.claims.schoolId));
      const flags = await roleFlags(deps.authStore, authed.membership.id);
      assertSelfService(input, authed, flags);
      const created = await deps.absenceStore.create(
        input,
        { userId: authed.claims.personId, via: "platform" },
        storedCertainty(input, flags),
      );
      res.status(201).json(readResponse(created, viewerOf(authed.membership, flags)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put(`${absences}/:id`, async (req, res) => {
    try {
      const authed = await requireMember(deps, req);
      const id = req.params.id as string;
      const body = bodyObject(req);
      if (body.id !== undefined && body.id !== id) {
        throw new AuthError(400, "入力が正しくありません");
      }
      const revision = parseRevision(body);
      const flags = await roleFlags(deps.authStore, authed.membership.id);
      const existing = await deps.absenceStore.get(authed.claims.schoolId, id);
      if (!existing) throw new AbsenceNotFoundError("absence", id);
      // Fields this caller may not see keep their stored values —
      // the body's word on them is not taken (see carriedFields).
      const viewer = viewerOf(authed.membership, flags);
      const carried = carriedFields(existing, viewer);
      const input = parseAbsenceInput(
        withSchool({ ...body, id, ...carried }, authed.claims.schoolId),
      );
      // A save that carries hidden fields over may not also change
      // the record's kind or the person it is about: the carried
      // values are hidden under the stored kind and person, and
      // under a new one they could become visible — a trip's texts
      // are shown to all staff, and a new person may read their own
      // record. Changing the kind or the person of such a record is
      // an Admin's work; an Admin sees every field, nothing is
      // carried for them, and this never refuses an Admin.
      if (
        Object.keys(carried).length > 0 &&
        (input.kind !== existing.kind || input.staffId !== existing.staffId)
      ) {
        throw new AuthError(403, "権限がありません");
      }
      if (!flags.isWriter) {
        // A non-writer may only edit their own absence, and may not
        // hand it to someone else in the edit either.
        if (
          !canWriteAbsence(existing, authed, flags) ||
          !isOwnAbsence(input, authed.membership.teacherId)
        ) {
          throw new AuthError(403, "権限がありません");
        }
      }
      const updated = await deps.absenceStore.update(
        { ...input, revision },
        { userId: authed.claims.personId, via: "platform" },
        storedCertainty(input, flags),
      );
      res.json(readResponse(updated, viewer));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(`${absences}/:id/confirm`, async (req, res) => {
    try {
      const authed = await requireWriter(deps, req);
      const revision = parseRevision(bodyObject(req));
      const confirmed = await deps.absenceStore.confirm(
        authed.claims.schoolId,
        req.params.id as string,
        revision,
        { userId: authed.claims.personId, via: "platform" },
      );
      const flags = await roleFlags(deps.authStore, authed.membership.id);
      res.json(readResponse(confirmed, viewerOf(authed.membership, flags)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete(`${absences}/:id`, async (req, res) => {
    try {
      const { claims } = await requireWriter(deps, req);
      const revision = parseRevision(bodyObject(req));
      await deps.absenceStore.remove(claims.schoolId, req.params.id as string, revision, {
        userId: claims.personId,
        via: "platform",
      });
      res.status(204).end();
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
