import { Router, type Response } from "express";
import { z } from "zod";
import type { AuthConfig } from "../auth/config.js";
import { AuthError } from "../auth/errors.js";
import { requireSchoolAdmin } from "../auth/guards.js";
import type { AuthStore } from "../db/authStore.js";
import {
  MembershipConflictError,
  MembershipNotFoundError,
  MembershipReferenceError,
  MembershipValidationError,
  type MembershipAdminStore,
} from "../db/membershipAdmin.js";
import type { Product, Role } from "../db/schema.js";

/**
 * The membership administration API (Issue #128):
 * /platform/api/v1/members*. Only an administrator of the session's
 * school (Admin in either product, D-4) may use it, and the school
 * is always the session's own — there is no school parameter, so a
 * request can only ever reach the caller's school's memberships
 * (tenant isolation). Invitations carry no email sending: the
 * administrator passes the login URL to the invitee themselves.
 */
export interface MembersRouterDeps {
  config: AuthConfig;
  authStore: AuthStore;
  membershipStore: MembershipAdminStore;
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof MembershipNotFoundError) {
    res.status(404).json({ error: "見つかりません" });
    return;
  }
  if (error instanceof MembershipConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof MembershipReferenceError || error instanceof MembershipValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "サーバーエラーが発生しました" });
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AuthError(400, "入力が正しくありません");
  }
  return parsed.data;
}

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const roleEntrySchema = z.object({
  product: z.enum(["schedule", "timetable"]),
  role: z.enum(["Admin", "Editor", "Viewer"]),
});

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).optional(),
  roles: z.array(roleEntrySchema).optional(),
  startsOn: dateStringSchema.optional(),
});

const endSchema = z.object({
  endsOn: dateStringSchema,
});

const setRoleSchema = z.object({
  product: z.enum(["schedule", "timetable"]),
  role: z.enum(["Admin", "Editor", "Viewer"]).nullable(),
});

const setTeacherSchema = z.object({
  teacherId: z.string().min(1).nullable(),
});

export function createMembersRouter(deps: MembersRouterDeps): Router {
  const router = Router();
  const store = deps.membershipStore;

  router.get("/members", async (req, res) => {
    try {
      const { claims } = await requireSchoolAdmin(deps, req);
      const items = await store.listMembers(claims.schoolId);
      res.json({ items });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/members/invite", async (req, res) => {
    try {
      const { claims } = await requireSchoolAdmin(deps, req);
      const input = parseBody(inviteSchema, req.body);
      const roles = (input.roles ?? []).map((r) => ({
        product: r.product as Product,
        role: r.role as Role,
      }));
      if (new Set(roles.map((r) => r.product)).size !== roles.length) {
        throw new AuthError(400, "入力が正しくありません");
      }
      const view = await store.inviteMember(claims.personId, claims.schoolId, {
        email: input.email,
        ...(input.name !== undefined ? { name: input.name } : {}),
        roles,
        ...(input.startsOn !== undefined ? { startsOn: input.startsOn } : {}),
      });
      res.status(201).json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/members/:membershipId/approve", async (req, res) => {
    try {
      const { claims } = await requireSchoolAdmin(deps, req);
      const view = await store.approveMember(
        claims.personId,
        claims.schoolId,
        req.params.membershipId as string,
      );
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/members/:membershipId/suspend", async (req, res) => {
    try {
      const { claims } = await requireSchoolAdmin(deps, req);
      const view = await store.suspendMember(
        claims.personId,
        claims.schoolId,
        req.params.membershipId as string,
      );
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/members/:membershipId/unsuspend", async (req, res) => {
    try {
      const { claims } = await requireSchoolAdmin(deps, req);
      const view = await store.unsuspendMember(
        claims.personId,
        claims.schoolId,
        req.params.membershipId as string,
      );
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/members/:membershipId/end", async (req, res) => {
    try {
      const { claims } = await requireSchoolAdmin(deps, req);
      const input = parseBody(endSchema, req.body);
      const view = await store.endMember(
        claims.personId,
        claims.schoolId,
        req.params.membershipId as string,
        input.endsOn,
      );
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put("/members/:membershipId/roles", async (req, res) => {
    try {
      const { claims } = await requireSchoolAdmin(deps, req);
      const input = parseBody(setRoleSchema, req.body);
      const view = await store.setMemberRole(
        claims.personId,
        claims.schoolId,
        req.params.membershipId as string,
        input.product as Product,
        input.role as Role | null,
      );
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put("/members/:membershipId/teacher", async (req, res) => {
    try {
      const { claims } = await requireSchoolAdmin(deps, req);
      const input = parseBody(setTeacherSchema, req.body);
      const view = await store.setMemberTeacher(
        claims.personId,
        claims.schoolId,
        req.params.membershipId as string,
        input.teacherId,
      );
      res.json(view);
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
