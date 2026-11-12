import { Router, type Request, type Response } from "express";
import {
  audienceSchema,
  calendarEventInputSchema,
  calendarEventRecordSchema,
  isValidDateString,
  type Audience,
  type CalendarEventInput,
} from "@school-manage/calendar-types";
import type { AuthConfig } from "../auth/config.js";
import { AuthError } from "../auth/errors.js";
import { isMembershipCandidate, todayString } from "../auth/membership.js";
import { readSessionToken } from "../auth/routes.js";
import { isSelectionClaims, verifyAuthToken, type SessionClaims } from "../auth/tokens.js";
import type { AuthStore } from "../db/authStore.js";
import { RevisionConflictError } from "../db/changes.js";
import {
  EventConflictError,
  EventNotFoundError,
  EventReferenceError,
  type EventStore,
} from "../db/events.js";
import type { Membership, Product } from "../db/schema.js";

/**
 * The school calendar events API (Issue #24, DESIGN-INTEGRATION 2.2 /
 * 6): /platform/api/v1/calendar/events. Reads need a current
 * membership of the session's school; writes need Editor or more in
 * either product （連携5), and every write goes through the events
 * store, which records it in the outbox.
 *
 * A read names its audience (staff by default; guardian / student /
 * public for the public views). The store applies the shared
 * audience filter, so an event the audience may not see is never in
 * the response, and assignee names reach staff only
 * (DESIGN-AUTH-TENANCY 4.5).
 */
export interface EventsRouterDeps {
  config: AuthConfig;
  authStore: AuthStore;
  eventStore: EventStore;
}

interface AuthedMember {
  claims: SessionClaims;
  membership: Membership;
}

function requireSession(deps: EventsRouterDeps, req: Request): SessionClaims {
  const token = readSessionToken(req);
  const claims = token ? verifyAuthToken(deps.config, token) : null;
  if (!claims || isSelectionClaims(claims)) throw new AuthError(401, "認証が必要です");
  return claims;
}

async function requireMember(deps: EventsRouterDeps, req: Request): Promise<AuthedMember> {
  const claims = requireSession(deps, req);
  const memberships = await deps.authStore.listMemberships(claims.personId);
  const today = todayString();
  const membership = memberships.find(
    (m) => m.schoolId === claims.schoolId && isMembershipCandidate(m, today),
  );
  if (!membership) throw new AuthError(403, "権限がありません");
  return { claims, membership };
}

/** Editor or more in either product may write the school calendar （連携5). */
async function requireWriter(deps: EventsRouterDeps, req: Request): Promise<AuthedMember> {
  const authed = await requireMember(deps, req);
  const products: Product[] = ["schedule", "timetable"];
  for (const product of products) {
    const role = await deps.authStore.findProductRole(authed.membership.id, product);
    if (role && (role.role === "Admin" || role.role === "Editor")) return authed;
  }
  throw new AuthError(403, "権限がありません");
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

function parseInput(candidate: Record<string, unknown>): CalendarEventInput {
  const parsed = calendarEventInputSchema.safeParse(candidate);
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

function parseAudience(req: Request): Audience {
  const value = req.query.audience;
  if (value === undefined) return "staff";
  const parsed = audienceSchema.safeParse(value);
  if (!parsed.success) throw new AuthError(400, "入力が正しくありません");
  return parsed.data;
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
  if (error instanceof EventNotFoundError) {
    res.status(404).json({ error: "見つかりません" });
    return;
  }
  if (error instanceof RevisionConflictError) {
    // error.latest was already filtered to the privacy-safe fields
    // by the events store (see eventConflictLatest).
    res.status(409).json({ error: "ほかの人が先に変更しました", latest: error.latest });
    return;
  }
  if (error instanceof EventConflictError) {
    res.status(409).json({ error: "その操作は現在の状態と競合します" });
    return;
  }
  if (error instanceof EventReferenceError) {
    res.status(400).json({ error: "参照先が同じ学校にありません" });
    return;
  }
  res.status(500).json({ error: "サーバーエラーが発生しました" });
}

export function createEventsRouter(deps: EventsRouterDeps): Router {
  const router = Router();
  const base = "/calendar/events";

  router.get(base, async (req, res) => {
    try {
      const { claims } = await requireMember(deps, req);
      const range = parseRange(req);
      const audience = parseAudience(req);
      const items = await deps.eventStore.listRange(claims.schoolId, range, audience);
      res.json({ items: items.map((item) => calendarEventRecordSchema.parse(item)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(`${base}/:id`, async (req, res) => {
    try {
      const { claims } = await requireMember(deps, req);
      const audience = parseAudience(req);
      const item = await deps.eventStore.get(claims.schoolId, req.params.id as string, audience);
      if (!item) throw new EventNotFoundError(req.params.id as string);
      res.json(calendarEventRecordSchema.parse(item));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(base, async (req, res) => {
    try {
      const { claims } = await requireWriter(deps, req);
      const input = parseInput(withSchool(bodyObject(req), claims.schoolId));
      const created = await deps.eventStore.create(input, {
        userId: claims.personId,
        via: "platform",
      });
      res.status(201).json(calendarEventRecordSchema.parse(created));
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
      const input = parseInput(withSchool({ ...body, id }, claims.schoolId));
      const updated = await deps.eventStore.update(
        { ...input, revision },
        { userId: claims.personId, via: "platform" },
      );
      res.json(calendarEventRecordSchema.parse(updated));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete(`${base}/:id`, async (req, res) => {
    try {
      const { claims } = await requireWriter(deps, req);
      const revision = parseRevision(bodyObject(req));
      await deps.eventStore.remove(claims.schoolId, req.params.id as string, revision, {
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
