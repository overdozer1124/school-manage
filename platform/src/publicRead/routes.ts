import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { isValidDateString } from "@school-manage/calendar-types";
import { AuthError } from "../auth/errors.js";
import type { AuthStore } from "../db/authStore.js";
import type { DayStore, HolidayStore } from "../db/days.js";
import type { EventStore } from "../db/events.js";
import type { MasterStore } from "../db/masters.js";
import type { School } from "../db/schema.js";
import {
  publicAudienceSchema,
  publicCalendarDaySchema,
  publicCalendarEventSchema,
  publicGradeSchema,
  publicHolidaySchema,
  publicSchoolSchema,
  type PublicAudience,
} from "./types.js";

/**
 * The public-read path (Issue #82): the reads the schedule server
 * makes for the public viewing pages (Issue #41), under
 * /platform/api/v1/public-read. There is no user and no session on
 * this path — the caller is the schedule server itself, and it
 * authenticates with a service credential (a bearer token from the
 * environment, PUBLIC_READ_SERVICE_TOKEN; its value is never in
 * code). A request without the credential, or with a wrong one, is
 * a 401, exactly as a session-less member read is.
 *
 * Every request names its school (schoolId or slug) and its
 * audience (guardian / student / public — staff cannot be named),
 * and the platform applies the audience filter itself
 * (DESIGN-INTEGRATION 6): what is returned is shaped by the public
 * schemas of ./types, so duties, people, assignees, leave and
 * staff_only events are absent by construction — most of them are
 * never even read. The schedule server narrows the answer further
 * with its view; the platform's filter is the floor, not a courtesy
 * the caller may skip.
 */
export interface PublicReadRouterDeps {
  authStore: AuthStore;
  dayStore: DayStore;
  holidayStore: HolidayStore;
  eventStore: EventStore;
  masterStore: MasterStore;
  /**
   * The service credential the schedule server presents, from
   * PUBLIC_READ_SERVICE_TOKEN. When it is not configured, every
   * request is refused: the path fails closed rather than opening
   * on a missing secret (the platform's stance for JWT_SECRET,
   * Issue #5, applied to a credential that guards other people's
   * children-facing data).
   */
  serviceToken: string | undefined;
}

export function loadPublicReadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Pick<PublicReadRouterDeps, "serviceToken"> {
  return { serviceToken: env.PUBLIC_READ_SERVICE_TOKEN || undefined };
}

function credentialMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireServiceCredential(deps: PublicReadRouterDeps, req: Request): void {
  const header = req.headers.authorization;
  const presented =
    typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!deps.serviceToken || !presented || !credentialMatches(presented, deps.serviceToken)) {
    throw new AuthError(401, "認証が必要です");
  }
}

interface PublicContext {
  school: School;
  audience: PublicAudience;
}

/**
 * The request's school and audience. The school is named by
 * schoolId or by slug — exactly one of them; naming both (or
 * neither) is a bad request, and a name no school answers to is a
 * 404. The audience must be a public one: staff is refused as a
 * bad request, in the same shape every router here refuses bad
 * input, before anything is read.
 */
async function parsePublicContext(
  deps: PublicReadRouterDeps,
  req: Request,
): Promise<PublicContext> {
  requireServiceCredential(deps, req);
  const audience = publicAudienceSchema.safeParse(req.query.audience);
  if (!audience.success) throw new AuthError(400, "入力が正しくありません");
  const schoolId = typeof req.query.schoolId === "string" ? req.query.schoolId : undefined;
  const slug = typeof req.query.slug === "string" ? req.query.slug : undefined;
  if ((schoolId === undefined) === (slug === undefined)) {
    throw new AuthError(400, "入力が正しくありません");
  }
  const school =
    schoolId !== undefined
      ? await deps.authStore.findSchool(schoolId)
      : await deps.authStore.findSchoolBySlug(slug as string);
  if (!school) throw new AuthError(404, "見つかりません");
  return { school, audience: audience.data };
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
  res.status(500).json({ error: "サーバーエラーが発生しました" });
}

export function createPublicReadRouter(deps: PublicReadRouterDeps): Router {
  const router = Router();
  const base = "/public-read";

  // The school itself: its name heads the public page.
  router.get(`${base}/school`, async (req, res) => {
    try {
      const { school } = await parsePublicContext(deps, req);
      res.json(
        publicSchoolSchema.parse({
          schoolId: school.schoolId,
          name: school.name,
          slug: school.slug,
        }),
      );
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(`${base}/calendar/days`, async (req, res) => {
    try {
      const { school } = await parsePublicContext(deps, req);
      const range = parseRange(req);
      const items = await deps.dayStore.listRange(school.schoolId, range);
      res.json({ items: items.map((item) => publicCalendarDaySchema.parse(item)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(`${base}/calendar/holidays`, async (req, res) => {
    try {
      const { school } = await parsePublicContext(deps, req);
      const range = parseRange(req);
      const items = await deps.holidayStore.listRange(school.schoolId, range);
      res.json({ items: items.map((item) => publicHolidaySchema.parse(item)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  // The events store applies the audience filter itself
  // (filterVisible + forAudience, DESIGN-INTEGRATION 6): a
  // staff_only event is never in the list, and a kept event's
  // assignees and staff-axis targets are already dropped. The
  // public schema then decides what of the record leaves at all.
  router.get(`${base}/calendar/events`, async (req, res) => {
    try {
      const { school, audience } = await parsePublicContext(deps, req);
      const range = parseRange(req);
      const items = await deps.eventStore.listRange(school.schoolId, range, audience);
      res.json({ items: items.map((item) => publicCalendarEventSchema.parse(item)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  // The one master the public side receives: grades label the
  // columns' per-grade values (下校時刻 by grade). The staff
  // master is not served on this path at all.
  router.get(`${base}/masters/grades`, async (req, res) => {
    try {
      const { school } = await parsePublicContext(deps, req);
      const items = await deps.masterStore.grades.list(school.schoolId);
      res.json({ items: items.map((item) => publicGradeSchema.parse(item)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
