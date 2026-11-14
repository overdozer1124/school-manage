import { defineActions } from "@school-manage/platform-client";
import {
  audienceColumns,
  audienceItems,
  datesInRange,
  eventDateSpan,
  viewAudienceRank,
  type Audience,
  type AudienceColumn,
  type AudienceItem,
  type DatePrecision,
} from "@school-manage/calendar-types";
import * as definitionsStore from "../db/definitions.js";
import * as dailyValuesStore from "../db/dailyValues.js";
import * as dutiesStore from "../db/duties.js";
import * as eventValuesStore from "../db/eventValues.js";
import * as templatesStore from "../db/kindTemplates.js";
import * as viewsStore from "../db/views.js";
import { tenantDb } from "../db/tenant.js";
import { scheduleAction, schedulePermissions } from "../permissions.js";
import { unwrapPlatformResult, type PlatformApiClient } from "../platformClient.js";
import {
  MAX_RANGE_DAYS,
  getBootstrapInputSchema,
  getRangeInputSchema,
  type RangeDay,
  type RangeResult,
  type RangeUndecided,
} from "./types.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

const DAYS_PATH = "/platform/api/v1/calendar/days";
const HOLIDAYS_PATH = "/platform/api/v1/calendar/holidays";
const EVENTS_PATH = "/platform/api/v1/calendar/events";
const ABSENCES_PATH = "/platform/api/v1/calendar/absences";
const ME_PATH = "/platform/api/v1/auth/me";
const MASTERS_PATH = "/platform/api/v1/masters";

/** The `items` of a platform list answer, as opaque records: the
 *  platform validated them against the shared schemas at its own
 *  boundary, and this server passes them through untouched. */
function itemsOf(body: unknown): Record<string, unknown>[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * The range actions (Issue #33): getRange, the one call a month or
 * week table is drawn from, and getBootstrap, the definitions and
 * masters a screen starts with. Both are view.read (DESIGN-AUTH-
 * TENANCY 4.4).
 *
 * getRange bundles, per date, the platform's school calendar (days,
 * holidays, events, absences — read with the caller's cookie, the
 * view's audience named to the platform, so the platform applies
 * the audience filter and the absence privacy shaping itself) with
 * this database's daily values, duty assignments and additional
 * items. The bundle is computed per read and never stored (DESIGN
 * schedule 4.6). What the platform returns is passed through as-is
 * — the leave subdivision a reader may not see is absent because
 * the platform left it out, not because this layer removed it —
 * and this layer then applies the view's own filter (Issue #32's
 * pure functions): the columns and daily items the view's audience
 * may see, duties and absences only for a staff view. A platform
 * refusal (401 / 403) is relayed as-is, as in the event relay.
 */
export function createRangeActions(db: Db, platformClient: PlatformApiClient) {
  async function platformItems(path: string, cookie: string): Promise<Record<string, unknown>[]> {
    return itemsOf(unwrapPlatformResult(await platformClient.getJson(path, cookie)));
  }

  return defineActions({
    getRange: scheduleAction("view.read", async ({ auth, request }): Promise<RangeResult> => {
      const input = getRangeInputSchema.parse(request);
      const dates = datesInRange(input.from, input.to);
      if (dates.length > MAX_RANGE_DAYS) {
        throw new Error(
          `range is too long: ${dates.length} days (one call covers at most ${MAX_RANGE_DAYS})`,
        );
      }

      const view = (await viewsStore.getViews(db, auth.schoolId)).find(
        (v) => v.id === input.viewId,
      );
      if (!view) {
        throw new Error(`view definition not found: ${input.viewId}`);
      }
      const staffView = view.audience === "staff";
      const rank = viewAudienceRank(view.audience as Audience);

      const range = `from=${input.from}&to=${input.to}`;
      const [
        definitionSet,
        dayRecords,
        holidayRecords,
        events,
        absenceRecords,
        dailyValues,
        assignments,
      ] = await Promise.all([
        definitionsStore.getDefinitionSet(db, auth.schoolId),
        platformItems(`${DAYS_PATH}?${range}`, input.cookie),
        platformItems(`${HOLIDAYS_PATH}?${range}`, input.cookie),
        platformItems(`${EVENTS_PATH}?${range}&audience=${view.audience}`, input.cookie),
        // Absences are staff dynamics (DESIGN schedule 5.2
        // scenario 8): a non-staff view never receives them, so
        // the platform is not even asked.
        staffView ? platformItems(`${ABSENCES_PATH}?${range}`, input.cookie) : [],
        dailyValuesStore.getDailyValues(db, auth.schoolId, {
          from: input.from,
          to: input.to,
        }),
        // Duties name people; they belong to staff views only
        // (DESIGN-AUTH-TENANCY 4.5), like the duty columns below.
        staffView
          ? dutiesStore.getAssignments(db, auth.schoolId, { from: input.from, to: input.to })
          : [],
      ]);

      // The view's own filter (Issue #32): which columns the
      // audience sees, and which daily items may appear at all.
      // The pure functions read slices (the database rows carry
      // the enum fields as text), so they judge slices and the
      // full rows are kept by id.
      const itemSlices = definitionSet.itemDefinitions as unknown as readonly Pick<
        AudienceItem,
        "id" | "defaultVisibility"
      >[];
      const keptColumns = audienceColumns(
        view.columns.map((column): AudienceColumn & { id: string } => ({
          id: column.id,
          sourceKind: column.sourceKind as AudienceColumn["sourceKind"],
          itemDefinitionId: column.itemDefinitionId,
          dutyDefinitionId: column.dutyDefinitionId,
        })),
        itemSlices,
        rank,
      );
      const keptColumnIds = new Set(keptColumns.map((column) => column.id));
      const columns = view.columns.filter((column) => keptColumnIds.has(column.id));
      const allowedItemIds = new Set(
        audienceItems(itemSlices, keptColumns, rank).map((item) => item.id),
      );

      const dayByDate = new Map<string, Record<string, unknown>>();
      for (const record of dayRecords) {
        const date = stringField(record, "date");
        if (date) dayByDate.set(date, record);
      }
      const holidaysByDate = new Map<string, Record<string, unknown>[]>();
      for (const record of holidayRecords) {
        const date = stringField(record, "date");
        if (!date) continue;
        const list = holidaysByDate.get(date) ?? [];
        list.push(record);
        holidaysByDate.set(date, list);
      }

      const days: RangeDay[] = dates.map((date) => ({
        date,
        day: dayByDate.get(date) ?? null,
        holidays: holidaysByDate.get(date) ?? [],
        events: [],
        absences: [],
        dailyValues: [],
        dutyAssignments: [],
      }));
      const dayIndex = new Map(days.map((day, i) => [day.date, i]));
      const pushOn = (
        date: string,
        key: "events" | "absences",
        record: Record<string, unknown>,
      ) => {
        const i = dayIndex.get(date);
        if (i !== undefined) days[i]?.[key].push(record);
      };

      // Events: day and range precision are placed on their days;
      // month and undecided precision are that month's (or the
      // school year's) undecided events, kept apart (scenario 9).
      const undecidedByMonth = new Map<string | null, Record<string, unknown>[]>();
      for (const event of events) {
        const precision = stringField(event, "datePrecision");
        if (precision === "month" || precision === "undecided") {
          const startsOn = stringField(event, "startsOn");
          const month = precision === "month" && startsOn ? startsOn.slice(0, 7) : null;
          const list = undecidedByMonth.get(month) ?? [];
          list.push(event);
          undecidedByMonth.set(month, list);
          continue;
        }
        const span = eventDateSpan({
          datePrecision: (precision ?? "day") as DatePrecision,
          startsOn: stringField(event, "startsOn"),
          endsOn: stringField(event, "endsOn"),
        });
        if (!span) continue;
        for (const date of dates) {
          if (date >= span.start && date <= span.end) pushOn(date, "events", event);
        }
      }
      const undecided: RangeUndecided[] = [...undecidedByMonth.entries()]
        .sort(([a], [b]) => ((a ?? "9999") < (b ?? "9999") ? -1 : 1))
        .map(([month, monthEvents]) => ({ month, events: monthEvents }));

      for (const absence of absenceRecords) {
        const fromDate = stringField(absence, "fromDate");
        const toDate = stringField(absence, "toDate");
        if (!fromDate || !toDate) continue;
        for (const date of dates) {
          if (date >= fromDate && date <= toDate) pushOn(date, "absences", absence);
        }
      }
      for (const value of dailyValues) {
        if (!allowedItemIds.has(value.itemDefinitionId)) continue;
        const i = dayIndex.get(value.date);
        if (i !== undefined) days[i]?.dailyValues.push(value);
      }
      for (const assignment of assignments) {
        const i = dayIndex.get(assignment.date);
        if (i !== undefined) days[i]?.dutyAssignments.push(assignment);
      }

      // Additional items for everything in the result, in two
      // queries. An absence the platform showed in its restricted
      // shape (no purpose field) contributes none — the platform's
      // judgment, read off the shape, exactly as getEventValues
      // does; an item the audience may not see contributes none
      // either.
      const absenceById = new Map<string, Record<string, unknown>>();
      for (const absence of absenceRecords) {
        const id = stringField(absence, "id");
        if (id) absenceById.set(id, absence);
      }
      const eventIds = events
        .map((event) => stringField(event, "id"))
        .filter((id): id is string => id !== null);
      const absenceIds = [...absenceById.keys()];
      const [eventValueRows, absenceValueRows] = await Promise.all([
        eventValuesStore.getEventValuesForSubjects(db, auth.schoolId, "event", eventIds),
        eventValuesStore.getEventValuesForSubjects(db, auth.schoolId, "absence", absenceIds),
      ]);
      const eventValues = [
        ...eventValueRows,
        ...absenceValueRows.filter((row) => {
          const absence = absenceById.get(row.subjectId);
          return absence !== undefined && "purpose" in absence;
        }),
      ].filter((row) => allowedItemIds.has(row.itemDefinitionId));

      return {
        view: { ...view, columns },
        from: input.from,
        to: input.to,
        days,
        undecided,
        eventValues,
        conflicts: [],
      };
    }),

    getBootstrap: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getBootstrapInputSchema.parse(request);
      const [me, staff, grades, dayPatterns, views, definitionSet, kindTemplates] =
        await Promise.all([
          unwrapPlatformResult(await platformClient.getJson(ME_PATH, input.cookie)),
          platformItems(`${MASTERS_PATH}/staff`, input.cookie),
          platformItems(`${MASTERS_PATH}/grades`, input.cookie),
          platformItems(`${MASTERS_PATH}/day-patterns`, input.cookie),
          viewsStore.getViews(db, auth.schoolId),
          definitionsStore.getDefinitionSet(db, auth.schoolId),
          templatesStore.getKindTemplates(db, auth.schoolId),
        ]);
      const school = (me as { school?: { name?: unknown } } | null)?.school;
      const permissions = Object.entries(schedulePermissions)
        .filter(([, roles]) => (roles as readonly string[]).includes(auth.role))
        .map(([name]) => name);
      return {
        school: {
          id: auth.schoolId,
          name: typeof school?.name === "string" ? school.name : null,
        },
        userId: auth.userId,
        teacherId: auth.teacherId,
        role: auth.role,
        permissions,
        views,
        itemDefinitions: definitionSet.itemDefinitions,
        targetGroups: definitionSet.targetGroups,
        kindTemplates,
        masters: { staff, grades, dayPatterns },
      };
    }),
  });
}
