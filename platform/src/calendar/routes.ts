import { Router, type Request, type Response } from "express";
import {
  calendarDayInputSchema,
  calendarDaySchema,
  holidayInputSchema,
  holidaySchema,
  isValidDateString,
  type CalendarDayInput,
  type HolidayInput,
} from "@school-manage/calendar-types";
import type { AuthConfig } from "../auth/config.js";
import { AuthError } from "../auth/errors.js";
import { requireMember, requireWriter } from "../auth/guards.js";
import type { AuthStore } from "../db/authStore.js";
import { RevisionConflictError } from "../db/changes.js";
import {
  CalendarEntryConflictError,
  CalendarEntryNotFoundError,
  CalendarEntryReferenceError,
  type CalendarEntryKind,
  type DayStore,
  type HolidayStore,
} from "../db/days.js";
/**
 * The school calendar days and holidays API (Issue #23,
 * DESIGN-INTEGRATION 2.1 / 6): /platform/api/v1/calendar/days and
 * /platform/api/v1/calendar/holidays. Reads need a current membership
 * of the session's school; writes need Editor or more in either
 * product （連携5, the same rule as the events API), and every write
 * goes through the day / holiday stores, which record it in the
 * outbox.
 *
 * Range reads return the days and holidays the school has recorded
 * in the range. A date with no day record does not appear: it is the
 * default day (a class day on a weekday, a closed day on a weekend),
 * which readers derive from the weekday.
 */
export interface CalendarRouterDeps {
  config: AuthConfig;
  authStore: AuthStore;
  dayStore: DayStore;
  holidayStore: HolidayStore;
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

function parseDayInput(candidate: Record<string, unknown>): CalendarDayInput {
  const parsed = calendarDayInputSchema.safeParse(candidate);
  if (!parsed.success) throw new AuthError(400, "入力が正しくありません");
  return parsed.data;
}

function parseHolidayInput(candidate: Record<string, unknown>): HolidayInput {
  const parsed = holidayInputSchema.safeParse(candidate);
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
  if (error instanceof CalendarEntryNotFoundError) {
    res.status(404).json({ error: "見つかりません" });
    return;
  }
  if (error instanceof RevisionConflictError) {
    // Days and holidays carry no private fields, so the store's
    // `latest` (the full current record) may go out as it is.
    res.status(409).json({ error: "ほかの人が先に変更しました", latest: error.latest });
    return;
  }
  if (error instanceof CalendarEntryConflictError) {
    res.status(409).json({ error: "その操作は現在の状態と競合します" });
    return;
  }
  if (error instanceof CalendarEntryReferenceError) {
    res.status(400).json({ error: "参照先が同じ学校にありません" });
    return;
  }
  res.status(500).json({ error: "サーバーエラーが発生しました" });
}

interface EntryStore<RecordT, InputT> {
  listRange(schoolId: string, range: { from: string; to: string }): Promise<RecordT[]>;
  get(schoolId: string, id: string): Promise<RecordT | undefined>;
  create(input: InputT, actor: { userId: string; via: "platform" }): Promise<RecordT>;
  update(
    input: InputT & { revision: number },
    actor: { userId: string; via: "platform" },
  ): Promise<RecordT>;
  remove(
    schoolId: string,
    id: string,
    expectedRevision: number,
    actor: { userId: string; via: "platform" },
  ): Promise<void>;
}

function mountEntries<RecordT, InputT>(
  router: Router,
  deps: CalendarRouterDeps,
  base: string,
  entryKind: CalendarEntryKind,
  store: EntryStore<RecordT, InputT>,
  parseInput: (candidate: Record<string, unknown>) => InputT,
  parseRecord: (item: unknown) => unknown,
): void {
  router.get(base, async (req, res) => {
    try {
      const { claims } = await requireMember(deps, req);
      const range = parseRange(req);
      const items = await store.listRange(claims.schoolId, range);
      res.json({ items: items.map((item) => parseRecord(item)) });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(`${base}/:id`, async (req, res) => {
    try {
      const { claims } = await requireMember(deps, req);
      const id = req.params.id as string;
      const item = await store.get(claims.schoolId, id);
      if (!item) throw new CalendarEntryNotFoundError(entryKind, id);
      res.json(parseRecord(item));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(base, async (req, res) => {
    try {
      const { claims } = await requireWriter(deps, req);
      const input = parseInput(withSchool(bodyObject(req), claims.schoolId));
      const created = await store.create(input, { userId: claims.personId, via: "platform" });
      res.status(201).json(parseRecord(created));
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
      const updated = await store.update(
        { ...input, revision },
        { userId: claims.personId, via: "platform" },
      );
      res.json(parseRecord(updated));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete(`${base}/:id`, async (req, res) => {
    try {
      const { claims } = await requireWriter(deps, req);
      const revision = parseRevision(bodyObject(req));
      await store.remove(claims.schoolId, req.params.id as string, revision, {
        userId: claims.personId,
        via: "platform",
      });
      res.status(204).end();
    } catch (error) {
      handleError(res, error);
    }
  });
}

export function createCalendarRouter(deps: CalendarRouterDeps): Router {
  const router = Router();
  mountEntries(router, deps, "/calendar/days", "day", deps.dayStore, parseDayInput, (item) =>
    calendarDaySchema.parse(item),
  );
  mountEntries(
    router,
    deps,
    "/calendar/holidays",
    "holiday",
    deps.holidayStore,
    parseHolidayInput,
    (item) => holidaySchema.parse(item),
  );
  return router;
}
