import { Router, type Request, type Response } from "express";
import {
  dayPatternRecordSchema,
  dayPatternSchema,
  gradeRecordSchema,
  gradeSchema,
  schoolClassRecordSchema,
  schoolClassSchema,
  specialNeedsClassRecordSchema,
  specialNeedsClassSchema,
  staffMemberRecordSchema,
  staffMemberSchema,
} from "@school-manage/calendar-types";
import type { AuthConfig } from "../auth/config.js";
import { AuthError } from "../auth/errors.js";
import { requireMember, requireWriter } from "../auth/guards.js";
import type { AuthStore } from "../db/authStore.js";
import { RevisionConflictError } from "../db/changes.js";
import {
  MasterConflictError,
  MasterNotFoundError,
  MasterReferenceError,
  type MasterCrud,
  type MasterStore,
} from "../db/masters.js";
/**
 * The shared masters API (Issue #22, DESIGN-INTEGRATION 2.4 / 3.1):
 * /platform/api/v1/masters/{staff,grades,classes,special-needs-classes,day-patterns}.
 * Reads need a current membership of the session's school; writes
 * need Editor or more in either product （連携5). Every write goes
 * through the masters store, which records it in the outbox.
 */
export interface MastersRouterDeps {
  config: AuthConfig;
  authStore: AuthStore;
  masterStore: MasterStore;
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

/** The slice of a zod schema this router uses (either zod major works). */
interface SchemaLike {
  safeParse(data: unknown): { success: boolean; data?: unknown };
  parse(data: unknown): unknown;
}

function parseInput<M>(schema: SchemaLike, candidate: Record<string, unknown>): M {
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) throw new AuthError(400, "入力が正しくありません");
  return parsed.data as M;
}

function parseRevision(body: Record<string, unknown>): number {
  const revision = body.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new AuthError(400, "入力が正しくありません");
  }
  return revision;
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof MasterNotFoundError) {
    res.status(404).json({ error: "見つかりません" });
    return;
  }
  if (error instanceof RevisionConflictError) {
    res.status(409).json({ error: "ほかの人が先に変更しました", latest: error.latest });
    return;
  }
  if (error instanceof MasterConflictError) {
    res.status(409).json({ error: "その操作は現在の状態と競合します" });
    return;
  }
  if (error instanceof MasterReferenceError) {
    res.status(400).json({ error: "参照先が同じ学校にありません" });
    return;
  }
  res.status(500).json({ error: "サーバーエラーが発生しました" });
}

/**
 * One master kind's routes. The crud's generics are erased here, as
 * in the store: each kind's own schemas validate every input and
 * output at this boundary, so the handler code can stay shared.
 */
interface KindConfig {
  segment: string;
  kind: "staff" | "grade" | "class" | "special_needs_class" | "day_pattern";
  crud(deps: MastersRouterDeps): MasterCrud<never, never>;
  baseSchema: SchemaLike;
  recordSchema: SchemaLike;
}

const KINDS: KindConfig[] = [
  {
    segment: "staff",
    kind: "staff",
    crud: (deps) => deps.masterStore.staff as MasterCrud<never, never>,
    baseSchema: staffMemberSchema,
    recordSchema: staffMemberRecordSchema,
  },
  {
    segment: "grades",
    kind: "grade",
    crud: (deps) => deps.masterStore.grades as MasterCrud<never, never>,
    baseSchema: gradeSchema,
    recordSchema: gradeRecordSchema,
  },
  {
    segment: "classes",
    kind: "class",
    crud: (deps) => deps.masterStore.classes as MasterCrud<never, never>,
    baseSchema: schoolClassSchema,
    recordSchema: schoolClassRecordSchema,
  },
  {
    segment: "special-needs-classes",
    kind: "special_needs_class",
    crud: (deps) => deps.masterStore.specialNeedsClasses as MasterCrud<never, never>,
    baseSchema: specialNeedsClassSchema,
    recordSchema: specialNeedsClassRecordSchema,
  },
  {
    segment: "day-patterns",
    kind: "day_pattern",
    crud: (deps) => deps.masterStore.dayPatterns as MasterCrud<never, never>,
    baseSchema: dayPatternSchema,
    recordSchema: dayPatternRecordSchema,
  },
];

export function createMastersRouter(deps: MastersRouterDeps): Router {
  const router = Router();

  for (const kind of KINDS) {
    const base = `/masters/${kind.segment}`;
    const crud = kind.crud(deps);

    router.get(base, async (req, res) => {
      try {
        const { claims } = await requireMember(deps, req);
        const items = await crud.list(claims.schoolId);
        res.json({ items: items.map((item) => kind.recordSchema.parse(item)) });
      } catch (error) {
        handleError(res, error);
      }
    });

    router.get(`${base}/:id`, async (req, res) => {
      try {
        const { claims } = await requireMember(deps, req);
        const item = await crud.get(claims.schoolId, req.params.id as string);
        if (!item) throw new MasterNotFoundError(kind.kind, req.params.id as string);
        res.json(kind.recordSchema.parse(item));
      } catch (error) {
        handleError(res, error);
      }
    });

    router.post(base, async (req, res) => {
      try {
        const { claims } = await requireWriter(deps, req);
        const input = parseInput<never>(
          kind.baseSchema,
          withSchool(bodyObject(req), claims.schoolId),
        );
        const created = await crud.create(input, {
          userId: claims.personId,
          via: "platform",
        });
        res.status(201).json(kind.recordSchema.parse(created));
      } catch (error) {
        handleError(res, error);
      }
    });

    router.put(`${base}/:id`, async (req, res) => {
      try {
        const { claims } = await requireWriter(deps, req);
        const id = req.params.id as string;
        const body = bodyObject(req);
        if (body.id !== undefined && body.id !== id) {
          throw new AuthError(400, "入力が正しくありません");
        }
        const revision = parseRevision(body);
        const input = parseInput(kind.baseSchema, withSchool({ ...body, id }, claims.schoolId));
        const updated = await crud.update({ ...(input as object), revision } as never, {
          userId: claims.personId,
          via: "platform",
        });
        res.json(kind.recordSchema.parse(updated));
      } catch (error) {
        handleError(res, error);
      }
    });

    router.delete(`${base}/:id`, async (req, res) => {
      try {
        const { claims } = await requireWriter(deps, req);
        const revision = parseRevision(bodyObject(req));
        await crud.remove(claims.schoolId, req.params.id as string, revision, {
          userId: claims.personId,
          via: "platform",
        });
        res.status(204).end();
      } catch (error) {
        handleError(res, error);
      }
    });
  }

  return router;
}
