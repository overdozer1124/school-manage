import { defineActions } from "@school-manage/platform-client";
import {
  audienceColumns,
  datesInRange,
  summarizeRange,
  viewAudienceRank,
  type Audience,
  type AudienceColumn,
  type AudienceItem,
  type DayType,
  type SummaryTargetInput,
  type SummaryValueInput,
} from "@school-manage/calendar-types";
import * as definitionsStore from "../db/definitions.js";
import * as dailyValuesStore from "../db/dailyValues.js";
import * as viewsStore from "../db/views.js";
import { tenantDb } from "../db/tenant.js";
import { scheduleAction } from "../permissions.js";
import type { PlatformApiClient } from "../platformClient.js";
import { dayTypeFor, platformItems } from "../range/actions.js";
import { MAX_RANGE_DAYS } from "../range/types.js";
import { getSummaryInputSchema, type SummaryResponse } from "./types.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

const DAYS_PATH = "/platform/api/v1/calendar/days";
const HOLIDAYS_PATH = "/platform/api/v1/calendar/holidays";
const MASTERS_PATH = "/platform/api/v1/masters";

/** The platform axes an item may vary over (the item definitions'
 *  check admits exactly these), with their masters paths, in the
 *  order their targets are reported. */
const AXIS_SEGMENTS: Record<string, string> = {
  grade: "grades",
  class: "classes",
  special_needs_class: "special-needs-classes",
};
const AXIS_ORDER = ["grade", "class", "special_needs_class"] as const;

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * Whether one option's symbol counts toward its item's days
 * (DESIGN schedule 4.4: item_options.counts_as_json is the
 * aggregation condition). The shipped presets write an object
 * naming what the symbol counts as — `{ lunch_day: true }` for
 * lunch's ○, `{ lunch_day: false }` for its × — so an option
 * counts when its condition names anything as true; a bare
 * `true` counts as well. Anything else (null, an object with no
 * true in it) does not count.
 */
function optionCounts(countsAs: unknown): boolean {
  if (countsAs === true) return true;
  if (countsAs !== null && typeof countsAs === "object") {
    return Object.values(countsAs as Record<string, unknown>).some((v) => v === true);
  }
  return false;
}

/**
 * The summary of one view over one period (Issue #47; DESIGN
 * schedule 8): the school days and the aggregatable items' days,
 * per month and in total, derived on every call — from the
 * platform's day types for the school days, and from the daily
 * values' symbols (their options' counts_as conditions) for the
 * items. Nothing is stored, so a changed day type or a changed
 * symbol changes the next read.
 *
 * The view names what is counted: the items are the view's own
 * daily-item columns whose definitions are active and
 * aggregatable (is_aggregatable), in the columns' order — the
 * summary foots the table the view draws, so an item the view
 * does not show is not totalled under it, and an item that is
 * not aggregatable (its days mean nothing as a count) never is.
 * The columns are the ones the view's audience may see, filtered
 * exactly as the range read filters them (audienceColumns over
 * the view audience's rank), so the counts never name an item
 * the table itself hides from that audience.
 * Days are classified by the range read's own rule (dayTypeFor),
 * and per-target counts key on the daily values' canonical
 * target keys, with names read from the platform's masters for
 * the shared axes and from this database's target groups for
 * the app axes.
 */
export async function computeSummary(
  db: Db,
  platformClient: PlatformApiClient,
  schoolId: string,
  input: { from: string; to: string; viewId: string; cookie: string },
): Promise<SummaryResponse> {
  const dates = datesInRange(input.from, input.to);
  if (dates.length > MAX_RANGE_DAYS) {
    throw new Error(
      `range is too long: ${dates.length} days (one call covers at most ${MAX_RANGE_DAYS})`,
    );
  }

  const view = (await viewsStore.getViews(db, schoolId)).find((v) => v.id === input.viewId);
  if (!view) {
    throw new Error(`view definition not found: ${input.viewId}`);
  }

  const definitionSet = await definitionsStore.getDefinitionSet(db, schoolId);
  const itemById = new Map(definitionSet.itemDefinitions.map((item) => [item.id, item]));
  // The view's own filter, the range read's own (Issue #32):
  // which columns the view's audience sees. The pure function
  // reads slices, so the full columns are kept by id.
  const itemSlices = definitionSet.itemDefinitions as unknown as readonly Pick<
    AudienceItem,
    "id" | "defaultVisibility"
  >[];
  const keptColumnIds = new Set(
    audienceColumns(
      view.columns.map((column): AudienceColumn & { id: string } => ({
        id: column.id,
        sourceKind: column.sourceKind as AudienceColumn["sourceKind"],
        itemDefinitionId: column.itemDefinitionId,
        dutyDefinitionId: column.dutyDefinitionId,
      })),
      itemSlices,
      viewAudienceRank(view.audience as Audience),
    ).map((column) => column.id),
  );
  const items: (typeof definitionSet.itemDefinitions)[number][] = [];
  const seenItemIds = new Set<string>();
  for (const column of view.columns) {
    if (!keptColumnIds.has(column.id)) continue;
    if (column.sourceKind !== "daily_item" || !column.itemDefinitionId) continue;
    if (seenItemIds.has(column.itemDefinitionId)) continue;
    const item = itemById.get(column.itemDefinitionId);
    if (!item || !item.isActive || !item.isAggregatable) continue;
    seenItemIds.add(item.id);
    items.push(item);
  }

  const range = `from=${input.from}&to=${input.to}`;
  const [dayRecords, holidayRecords, dailyValues] = await Promise.all([
    platformItems(platformClient, `${DAYS_PATH}?${range}`, input.cookie),
    platformItems(platformClient, `${HOLIDAYS_PATH}?${range}`, input.cookie),
    dailyValuesStore.getDailyValues(db, schoolId, { from: input.from, to: input.to }),
  ]);

  const recordedByDate = new Map<string, Record<string, unknown>>();
  for (const record of dayRecords) {
    const date = stringField(record, "date");
    if (date) recordedByDate.set(date, record);
  }
  const holidayDates = new Set<string>();
  for (const record of holidayRecords) {
    const date = stringField(record, "date");
    if (date) holidayDates.add(date);
  }
  const days = dates.map((date) => ({
    date,
    dayType: dayTypeFor(date, recordedByDate.get(date), holidayDates.has(date)) as DayType,
  }));

  const itemIds = new Set(items.map((item) => item.id));
  const countsByOptionId = new Map<string, boolean>();
  for (const item of items) {
    for (const option of item.options) {
      countsByOptionId.set(option.id, optionCounts(option.countsAs));
    }
  }
  const values: SummaryValueInput[] = [];
  for (const row of dailyValues) {
    if (!itemIds.has(row.itemDefinitionId)) continue;
    values.push({
      date: row.date,
      itemId: row.itemDefinitionId,
      targetId: row.targetKey === "" ? null : row.targetKey,
      counts: row.valueOptionId !== null && (countsByOptionId.get(row.valueOptionId) ?? false),
    });
  }

  // The names of the targets the values name: the platform's
  // masters for the shared axes the counted items and values
  // actually use, and this database's target groups for the app
  // axes (a value's canonical key is `app:<target id>` there,
  // `<axis>:<master id>` for a shared axis). A target no list
  // names keeps its own key as its name, in the pure function.
  const neededAxes = new Set<string>();
  for (const item of items) {
    if (item.targetPlatformAxis) neededAxes.add(item.targetPlatformAxis);
  }
  for (const value of values) {
    const axis = value.targetId?.split(":")[0];
    if (axis && axis in AXIS_SEGMENTS) neededAxes.add(axis);
  }
  const targets: SummaryTargetInput[] = [];
  for (const axis of AXIS_ORDER) {
    if (!neededAxes.has(axis)) continue;
    const records = await platformItems(
      platformClient,
      `${MASTERS_PATH}/${AXIS_SEGMENTS[axis]}`,
      input.cookie,
    );
    for (const record of records) {
      const id = stringField(record, "id");
      if (!id) continue;
      targets.push({ targetId: `${axis}:${id}`, name: stringField(record, "name") ?? id });
    }
  }
  for (const group of definitionSet.targetGroups) {
    for (const target of group.targets) {
      targets.push({ targetId: `app:${target.id}`, name: target.name });
    }
  }

  const result = summarizeRange({
    days,
    items: items.map((item) => ({ itemId: item.id, name: item.name })),
    values,
    targets,
  });
  return { from: input.from, to: input.to, viewId: view.id, ...result };
}

/**
 * The summary action (Issue #47): getSummary, the counts a month
 * table foots itself with and a year table tabulates. It is
 * view.read (DESIGN-AUTH-TENANCY 4.4, whose table already names
 * getSummary under it): every role may read the counts of a view
 * they may read.
 */
export function createSummaryActions(db: Db, platformClient: PlatformApiClient) {
  return defineActions({
    getSummary: scheduleAction("view.read", async ({ auth, request }): Promise<SummaryResponse> => {
      const input = getSummaryInputSchema.parse(request);
      return computeSummary(db, platformClient, auth.schoolId, input);
    }),
  });
}
