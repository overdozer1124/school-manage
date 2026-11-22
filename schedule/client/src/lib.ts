import {
  addDays,
  calendarTimeToPeriods,
  datesInRange,
  formatGroupedValues,
  isValidTimeString,
  timeToMinutes,
  weekStartOf as firstDayOfWeek,
  weekdayOf,
  type CalendarTime,
  type Weekday,
} from "@school-manage/calendar-types";
import type {
  BootstrapData,
  DailyValueData,
  DutyConflictData,
  ItemDefinitionData,
  KindTemplateData,
  MasterEntry,
  RangeData,
  RangeDayData,
  TargetGroupData,
  TargetRefData,
  ViewColumnData,
  ViewDefinitionData,
} from "./types";

/**
 * Pure helpers for the schedule screens (Issue #34), ported from the
 * prototype's client/src/lib.ts (school-schedule, frozen) and
 * rewritten for this implementation's data shapes: ids are strings,
 * dates are YYYY-MM-DD text, and the shared date functions come from
 * @school-manage/calendar-types instead of being re-derived here.
 * The prototype's input-side helpers (quick add, drag, entitlements)
 * are not ported: input arrives with the following issues.
 */

export { addDays, datesInRange };

export const WEEKDAY_LABELS: Record<string, string> = {
  sun: "日",
  mon: "月",
  tue: "火",
  wed: "水",
  thu: "木",
  fri: "金",
  sat: "土",
};

export function weekdayLabel(date: string): string {
  return WEEKDAY_LABELS[weekdayOf(date)] ?? "";
}

/** "2026-11-15" -> "2026年11月" */
export function monthLabel(anchor: string): string {
  return `${anchor.slice(0, 4)}年${Number(anchor.slice(5, 7))}月`;
}

/** "2026-11-15" -> "11/15（日）" */
export function dayLabel(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（${weekdayLabel(date)}）`;
}

/** "2026-11-15" -> "2026年度" (the school year the date belongs to) */
export function yearLabel(anchor: string): string {
  return `${schoolYearOf(anchor)}年度`;
}

/** The twelve months of a school year, April first, as
 *  { year, month } pairs: April–December of the school year,
 *  then January–March of the next calendar year. */
export function schoolYearMonths(schoolYear: number): { year: number; month: number }[] {
  const months: { year: number; month: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const month = 4 + i;
    months.push(
      month <= 12 ? { year: schoolYear, month } : { year: schoolYear + 1, month: month - 12 },
    );
  }
  return months;
}

/**
 * An instant the server recorded (an ISO string, in UTC) shown
 * as "2026-11-17 06:51" in local time — the reader's own zone,
 * which for this app's schools is Japan's. The instant is
 * converted, never sliced out of the string: slicing shows the
 * UTC wall clock, nine hours behind the school's day (Issue #41
 * review). The optional zone exists for tests, which pin a zone
 * and so read the same answer on any machine; the screens pass
 * nothing and get the browser's zone. An unparseable value is
 * returned as it came rather than rendered as NaN parts.
 */
export function formatIssuedAt(iso: string, timeZone?: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("ja-JP", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

export function monthStartOf(anchor: string): string {
  return `${anchor.slice(0, 7)}-01`;
}

export function monthEndOf(anchor: string): string {
  // Last day of the month: the first of the next month minus one day.
  return addDays(addMonths(monthStartOf(anchor), 1), -1);
}

export function addMonths(anchor: string, n: number): string {
  const [y, m] = [Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7))];
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** Monday-start week containing the date (the school setting's
 *  default week start; layout_params may override it later). */
export function weekStartOf(anchor: string): string {
  const labels = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const idx = labels.indexOf(weekdayOf(anchor));
  return addDays(anchor, -((idx + 6) % 7));
}

/** How many days an L2 view spans: layout_params.days, else the
 *  period scope (week = 7, two_weeks = 14), else 7. */
export function weekSpanOf(view: ViewDefinitionData): number {
  const days = view.layoutParams?.["days"];
  if (typeof days === "number" && (days === 7 || days === 14)) return days;
  return view.periodScope === "two_weeks" ? 14 : 7;
}

const WEEKDAY_ORDER: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * The weekday a calendar_grid view's weeks start on (Issue #43):
 * the view's layout_params.weekStart — the layout parameter the
 * design names for it (§4.8's layout_params_json: 週の開始曜日）.
 * A weekday code ("mon") reads as itself; a number reads as the
 * JS weekday number (0 = Sunday … 6 = Saturday), with 7 also
 * Sunday, its ISO reading — the two conventions agree on 1–6,
 * Monday to Saturday. Anything else falls back to Monday, the
 * school default the rows layouts already keep (weekStartOf
 * above).
 */
export function gridWeekStart(view: ViewDefinitionData): Weekday {
  const raw = view.layoutParams?.["weekStart"];
  if (typeof raw === "string" && (WEEKDAY_ORDER as string[]).includes(raw)) {
    return raw as Weekday;
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    if (raw === 7) return "sun";
    if (raw >= 0 && raw <= 6) return WEEKDAY_ORDER[raw] as Weekday;
  }
  return "mon";
}

/**
 * The [from, to] a calendar_grid view asks getRange for: the
 * anchor's month, padded out to whole weeks — from the week's
 * first day (the view's week start) of the week holding the 1st,
 * to the last day of the week holding the month's end. The grid
 * draws those padding days as the neighbouring months' days, so
 * they have to be in the bundle.
 */
export function calendarGridRange(
  view: ViewDefinitionData,
  anchor: string,
): { from: string; to: string } {
  const start = gridWeekStart(view);
  const from = firstDayOfWeek(monthStartOf(anchor), start);
  const to = addDays(firstDayOfWeek(monthEndOf(anchor), start), 6);
  return { from, to };
}

/** The grid's weeks: the padded month as rows of seven dates,
 *  each row starting on the view's week-start weekday. */
export function calendarWeeks(view: ViewDefinitionData, anchor: string): string[][] {
  const { from, to } = calendarGridRange(view, anchor);
  const dates = datesInRange(from, to);
  const weeks: string[][] = [];
  for (let i = 0; i < dates.length; i += 7) weeks.push(dates.slice(i, i + 7));
  return weeks;
}

/** The [from, to] a week_timeline view asks getRange for: the
 *  seven days of the anchor's week, starting on the view's
 *  week-start weekday — the same setting the calendar grid
 *  reads (gridWeekStart), Monday by default. */
export function timelineRange(
  view: ViewDefinitionData,
  anchor: string,
): { from: string; to: string } {
  const from = firstDayOfWeek(anchor, gridWeekStart(view));
  return { from, to: addDays(from, 6) };
}

/**
 * The [from, to] a transposed view asks getRange for (Issue
 * #45): the days are the table's columns, so the span is the
 * view's period scope — a week or two weeks from the week's
 * first day, the anchor's month, or the whole school year.
 * The month is the scope the club tables are kept in (the
 * prototype drew the displayed month), and it is the fallback
 * for a view that names no scope.
 */
export function transposedRange(
  view: ViewDefinitionData,
  anchor: string,
): { from: string; to: string } {
  if (view.periodScope === "week" || view.periodScope === "two_weeks") {
    const from = weekStartOf(anchor);
    return { from, to: addDays(from, weekSpanOf(view) - 1) };
  }
  if (view.periodScope === "year") {
    const year = schoolYearOf(anchor);
    return { from: `${year}-04-01`, to: `${year + 1}-03-31` };
  }
  return { from: monthStartOf(anchor), to: monthEndOf(anchor) };
}

/** The [from, to] a view asks getRange for, from the anchor date. */
export function rangeFor(view: ViewDefinitionData, anchor: string): { from: string; to: string } {
  if (view.layout === "transposed") {
    return transposedRange(view, anchor);
  }
  if (view.layout === "week_rows") {
    const from = weekStartOf(anchor);
    return { from, to: addDays(from, weekSpanOf(view) - 1) };
  }
  if (view.layout === "week_timeline") {
    return timelineRange(view, anchor);
  }
  if (view.layout === "calendar_grid") {
    return calendarGridRange(view, anchor);
  }
  if (view.layout === "year_columns") {
    // The whole school year the anchor belongs to, April 1 to
    // March 31 — 365 days, 366 in a year holding a February 29,
    // which is exactly the range read's cap (Issue #42).
    const year = schoolYearOf(anchor);
    return { from: `${year}-04-01`, to: `${year + 1}-03-31` };
  }
  // month_rows (and any other layout shown as rows for now)
  return { from: monthStartOf(anchor), to: monthEndOf(anchor) };
}

/** Step the anchor by one period of the view's layout. */
export function stepAnchor(view: ViewDefinitionData, anchor: string, dir: 1 | -1): string {
  if (view.layout === "week_rows") return addDays(anchor, dir * weekSpanOf(view));
  if (view.layout === "week_timeline") return addDays(anchor, dir * 7);
  if (view.layout === "year_columns") return addMonths(anchor, dir * 12);
  if (view.layout === "transposed") {
    // Step by the span the table shows: its period scope.
    if (view.periodScope === "week" || view.periodScope === "two_weeks") {
      return addDays(anchor, dir * weekSpanOf(view));
    }
    if (view.periodScope === "year") return addMonths(anchor, dir * 12);
    return addMonths(anchor, dir);
  }
  // month_rows and calendar_grid both step by months.
  return addMonths(anchor, dir);
}

// ---- day classification (DESIGN schedule 9.1) ---------------------

/**
 * How a day is marked in the table. Colour is never the only signal:
 * Saturdays carry （土）, Sundays and holidays carry （日）/ the
 * holiday's name, and a closed day is also named in the sub-line, so
 * a monochrome print still tells the days apart.
 */
export interface DayMark {
  /** CSS class key: "sat" | "sun" | "holiday" | "" */
  kind: "sat" | "sun" | "holiday" | "";
  /** Text shown under the date: holiday names, the day type label,
   *  the day-pattern code — the non-colour signal. */
  sub: string;
  closed: boolean;
}

const DAY_TYPE_LABELS: Record<string, string> = {
  class_day: "",
  event_day: "行事日",
  exam_day: "試験日",
  closed_day: "休業日",
  long_vacation: "長期休業",
  make_up_day: "振替授業日",
};

export function dayMark(
  day: RangeDayData,
  dayPatterns: BootstrapData["masters"]["dayPatterns"],
): DayMark {
  const weekday = weekdayOf(day.date);
  const holidayNames = day.holidays
    .map((h) => (typeof h["name"] === "string" ? (h["name"] as string) : null))
    .filter((n): n is string => n !== null);
  const isHoliday = holidayNames.length > 0;
  const dayType = typeof day.day["dayType"] === "string" ? (day.day["dayType"] as string) : null;
  const parts: string[] = [...holidayNames];
  if (dayType && DAY_TYPE_LABELS[dayType]) parts.push(DAY_TYPE_LABELS[dayType] as string);
  const label =
    typeof day.day["dayTypeLabel"] === "string" ? (day.day["dayTypeLabel"] as string) : null;
  if (label) parts.push(label);
  const scheduleId =
    typeof day.day["dayScheduleId"] === "string" ? (day.day["dayScheduleId"] as string) : null;
  if (scheduleId) {
    const pattern = dayPatterns.find((p) => p.id === scheduleId);
    if (pattern?.code) parts.push(`${pattern.code}日課`);
  }
  const kind: DayMark["kind"] =
    isHoliday || weekday === "sun" ? "holiday" : weekday === "sat" ? "sat" : "";
  return {
    kind,
    sub: parts.join(" "),
    closed:
      dayType === "closed_day" || dayType === "long_vacation" || isHoliday || weekday === "sun",
  };
}

// ---- cell values ---------------------------------------------------

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The display text of one event record, as the platform shapes it. */
export function eventTitle(event: Record<string, unknown>): string {
  return stringField(event, "title") ?? stringField(event, "kindLabel") ?? "（無題）";
}

/** A short time prefix for an event ("9:00 " etc.), when it has one. */
export function eventTimeText(event: Record<string, unknown>): string {
  const time = event["time"];
  if (typeof time !== "object" || time === null) return "";
  const t = time as Record<string, unknown>;
  if (t["kind"] === "clock" && typeof t["startsAt"] === "string") {
    return typeof t["endsAt"] === "string"
      ? `${t["startsAt"]}〜${t["endsAt"]} `
      : `${t["startsAt"]} `;
  }
  if (t["kind"] === "half_day") return t["half"] === "pm" ? "午後 " : "午前 ";
  return "";
}

/** The text one daily value shows, before any target grouping. */
export function dailyValueText(value: DailyValueData, item: ItemDefinitionData): string {
  if (value.valueOptionId) {
    const option = item.options.find((o) => o.id === value.valueOptionId);
    if (option) return option.label;
  }
  if (value.valueTime) {
    return value.valueTimeEnd ? `${value.valueTime}〜${value.valueTimeEnd}` : value.valueTime;
  }
  if (value.valueText) return value.valueText;
  if (value.valueNumber !== null) return String(value.valueNumber);
  if (value.valueBoolean !== null) return value.valueBoolean ? "○" : "×";
  return "";
}

/** Which target a daily value belongs to, as a display name. */
function targetNameOf(
  value: DailyValueData,
  item: ItemDefinitionData,
  bootstrap: BootstrapData,
): string | null {
  if (value.targetRef) {
    if (value.targetRef.axis === "grade") {
      return bootstrap.masters.grades.find((g) => g.id === value.targetRef?.id)?.name ?? null;
    }
    if (value.targetRef.axis === "app") {
      for (const group of bootstrap.targetGroups) {
        const target = group.targets.find((t) => t.id === value.targetRef?.id);
        if (target) return target.shortName ?? target.name;
      }
      return null;
    }
    return null;
  }
  if (value.targetId) {
    for (const group of bootstrap.targetGroups) {
      const target = group.targets.find((t) => t.id === value.targetId);
      if (target) return target.shortName ?? target.name;
    }
    return null;
  }
  void item;
  return null;
}

/** The ordered target entries of an item's axis, for grouping. */
export function axisEntries(
  item: ItemDefinitionData,
  bootstrap: BootstrapData,
): { id: string; name: string }[] {
  if (item.targetGroupId) {
    const group: TargetGroupData | undefined = bootstrap.targetGroups.find(
      (g) => g.id === item.targetGroupId,
    );
    return (group?.targets ?? []).map((t) => ({ id: t.id, name: t.shortName ?? t.name }));
  }
  if (item.targetPlatformAxis === "grade") {
    return bootstrap.masters.grades.map((g) => ({ id: g.id, name: g.name ?? g.id }));
  }
  return [];
}

/**
 * The transposed table's reading of a view (Issue #45; DESIGN
 * schedule 4.8: layout=transposed ＋ the view's target axis):
 * the rows are the members of one target axis, the columns are
 * the days, and each cell is that target's daily value — the
 * same per-target DailyValue the rows tables group into one
 * cell under 4.8.2, ungrouped here because each row is one
 * target already. The axis is the first of the view's daily
 * items that ranges over an axis (the prototype's reading);
 * daily items on that same axis are drawn with it, and items
 * on another axis — or on none — cannot be rows of this table
 * and are named under it instead of being dropped silently.
 */
export interface TransposedModel {
  /** The item whose axis the rows are. */
  axisItem: ItemDefinitionData;
  /** The row axis's name （部活動 / 学年 / …). */
  axisLabel: string;
  /** The rows, in the axis's own order. */
  entries: { id: string; name: string }[];
  /** The daily-item columns drawn in the cells: the ones whose
   *  items range over the row axis. */
  shown: { column: ViewColumnData; item: ItemDefinitionData }[];
  /** The view's other daily items, not drawn in this table. */
  others: ItemDefinitionData[];
}

export function transposedModel(
  bootstrap: BootstrapData,
  columns: ViewColumnData[],
): TransposedModel | null {
  const daily = [...columns]
    .sort((a, b) => a.sort - b.sort)
    .filter((c) => c.sourceKind === "daily_item")
    .map((column) => ({
      column,
      item: bootstrap.itemDefinitions.find((i) => i.id === column.itemDefinitionId) ?? null,
    }))
    .filter((x): x is { column: ViewColumnData; item: ItemDefinitionData } => x.item !== null);
  const axis = daily.find(({ item }) => axisEntries(item, bootstrap).length > 0);
  if (!axis) return null;
  const onAxis = (item: ItemDefinitionData) =>
    item.targetGroupId === axis.item.targetGroupId &&
    item.targetPlatformAxis === axis.item.targetPlatformAxis;
  const group = axis.item.targetGroupId
    ? bootstrap.targetGroups.find((g) => g.id === axis.item.targetGroupId)
    : null;
  return {
    axisItem: axis.item,
    axisLabel: group?.name ?? (axis.item.targetPlatformAxis === "grade" ? "学年" : axis.item.name),
    entries: axisEntries(axis.item, bootstrap),
    shown: daily.filter(({ item }) => onAxis(item)),
    others: daily.filter(({ item }) => !onAxis(item)).map(({ item }) => item),
  };
}

/** The target ids one event record names as its targets — the
 *  platform keeps them as target references ({ axis, id } /
 *  { axis: "app", app, axisKey, id }), and the transposed table
 *  reads the ids alone: a target's id is unique across axes. */
export function eventTargetIds(event: Record<string, unknown>): string[] {
  const targets = event["targets"];
  if (!Array.isArray(targets)) return [];
  const ids: string[] = [];
  for (const target of targets) {
    if (typeof target !== "object" || target === null) continue;
    const id = (target as Record<string, unknown>)["id"];
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * The text of one daily_item cell. Values that belong to targets are
 * grouped with the shared pure function of Issue #32
 * (formatGroupedValues, DESIGN schedule 4.8.2) unless the column
 * switches grouping off; values without a target are listed plainly.
 */
export function dailyCellText(
  day: RangeDayData,
  column: ViewColumnData,
  bootstrap: BootstrapData,
): string {
  const item = bootstrap.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
  if (!item) return "";
  const values = day.dailyValues.filter((v) => v.itemDefinitionId === item.id);
  if (values.length === 0) return "";
  const plain = values.filter((v) => targetNameOf(v, item, bootstrap) === null);
  const targeted = values.filter((v) => targetNameOf(v, item, bootstrap) !== null);
  const parts: string[] = plain.map((v) => dailyValueText(v, item));
  if (targeted.length > 0) {
    const byTarget = new Map<string, string>();
    for (const v of targeted) {
      const name = targetNameOf(v, item, bootstrap);
      if (name) byTarget.set(name, dailyValueText(v, item));
    }
    const entries = axisEntries(item, bootstrap)
      .filter((e) => byTarget.has(e.name))
      .map((e) => ({ name: e.name, value: byTarget.get(e.name) ?? null }));
    // Targets the axis list does not know keep their own line.
    const known = new Set(entries.map((e) => e.name));
    for (const [name, text] of byTarget) {
      if (!known.has(name)) entries.push({ name, value: text });
    }
    parts.push(formatGroupedValues(entries, { groupSameValues: column.groupSameValues }));
  }
  return parts.filter((p) => p !== "").join("／");
}

/** The text of one duty cell: the holders' names, by slot. */
export function dutyCellText(
  day: RangeDayData,
  column: ViewColumnData,
  bootstrap: BootstrapData,
): string {
  const assignments = day.dutyAssignments.filter(
    (a) => a.dutyDefinitionId === column.dutyDefinitionId,
  );
  if (assignments.length === 0) return "";
  const slotOrder = ["am", "pm", "all_day", "week"];
  const sorted = [...assignments].sort(
    (a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot),
  );
  return sorted
    .map((a) => {
      const name = staffName(bootstrap, a.personId);
      if (a.slot === "am") return `午前 ${name}`;
      if (a.slot === "pm") return `午後 ${name}`;
      return name;
    })
    .join("／");
}

/** A staff member's display name; an empty cell reads （未定）. */
export function staffName(bootstrap: BootstrapData, personId: string | null): string {
  if (!personId) return "（未定）";
  return bootstrap.masters.staff.find((s) => s.id === personId)?.name ?? personId;
}

const ABSENCE_KIND_LABELS: Record<string, string> = {
  business_trip: "出張",
  training: "研修",
  leave: "休暇",
  other: "不在",
};

/** The display label of an absence kind (出張 / 研修 / 休暇). */
export function absenceKindLabel(kind: string | null): string {
  return (kind && ABSENCE_KIND_LABELS[kind]) || "不在";
}

/** The display label of a duty slot: 午前 / 午後 / 週 / ○限. An
 *  all-day slot carries no label — it is the unmarked case. */
export function slotLabel(slot: string): string {
  if (slot === "am") return "午前";
  if (slot === "pm") return "午後";
  if (slot === "week") return "週";
  if (slot === "all_day") return "";
  return `${slot}限`;
}

/**
 * One line of a duty cell (Issue #38): the holder's name, the
 * swapped mark when a change was applied to the row (origin
 * "swap" — the table shows that a change happened, never the
 * history itself, DESIGN schedule 4.7.1), and the warning text
 * when a derived conflict touches the assignment. A conflict from
 * a not-yet-confirmed absence says so （仮の…), so a tentative
 * absence is told apart from a confirmed one (DESIGN-AUTH-TENANCY
 * 4.6). An applicable cell with no assignment stands as its own
 * line, marked 未割当.
 */
export interface DutyCellLine {
  assignmentId: string | null;
  slot: string;
  text: string;
  swapped: boolean;
  warning: string | null;
}

export function dutyCellLines(
  day: RangeDayData,
  column: ViewColumnData,
  bootstrap: BootstrapData,
  conflicts: DutyConflictData[],
): DutyCellLine[] {
  const cellConflicts = conflicts.filter(
    (c) => c.dutyDefinitionId === column.dutyDefinitionId && c.date === day.date,
  );
  const warningFor = (assignmentId: string): string | null => {
    const conflict = cellConflicts.find(
      (c) => c.assignmentId === assignmentId || c.otherAssignmentId === assignmentId,
    );
    if (!conflict) return null;
    if (conflict.kind === "double") return "当番が二重です";
    if (conflict.kind === "absence") {
      const label = absenceKindLabel(conflict.absenceKind);
      return conflict.certainty === "tentative"
        ? `仮の${label}と重なっています`
        : `${label}と重なっています`;
    }
    return null;
  };
  const slotOrder = ["am", "pm", "all_day", "week"];
  const assignments = [...day.dutyAssignments]
    .filter((a) => a.dutyDefinitionId === column.dutyDefinitionId)
    .sort((a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot));
  const lines: DutyCellLine[] = assignments.map((a) => {
    const prefix = a.slot === "am" ? "午前 " : a.slot === "pm" ? "午後 " : "";
    return {
      assignmentId: a.id,
      slot: a.slot,
      text: `${prefix}${staffName(bootstrap, a.personId)}`,
      swapped: a.origin === "swap",
      warning: warningFor(a.id),
    };
  });
  for (const conflict of cellConflicts) {
    if (conflict.kind !== "unassigned") continue;
    if (lines.some((line) => line.slot === conflict.slot)) continue;
    const label = slotLabel(conflict.slot);
    lines.push({
      assignmentId: null,
      slot: conflict.slot,
      text: label,
      swapped: false,
      warning: "未割当です",
    });
  }
  return lines;
}

/** The text of one event_category cell: the day's events, in the
 *  order the platform returned them. Event categories in this
 *  implementation are the platform's event kinds, so a category
 *  column without a narrower key shows the day's events; absence
 *  records are not events and are not mixed in here. */
export function eventCellLines(day: RangeDayData): string[] {
  return day.events.map((e) => `${eventTimeText(e)}${eventTitle(e)}`);
}

/** The span of one event record, from its startsOn / endsOn.
 *  Null when the record carries no usable span (a month-precision
 *  or undecided event never reaches a day's events, so what is
 *  here is day / range precision). */
export function eventSpan(event: Record<string, unknown>): { start: string; end: string } | null {
  const start = stringField(event, "startsOn");
  const end = stringField(event, "endsOn");
  if (!start || !end || end < start) return null;
  return { start, end };
}

/** The span of one absence record, from its fromDate / toDate. */
export function absenceSpan(
  absence: Record<string, unknown>,
): { start: string; end: string } | null {
  const start = stringField(absence, "fromDate");
  const end = stringField(absence, "toDate");
  if (!start || !end || end < start) return null;
  return { start, end };
}

/**
 * Lane assignment for one week's period bars (Issue #43): bars
 * that overlap in time may not share a lane, so each bar takes
 * the first lane whose last bar has ended before it starts.
 * Bars are read in span order — earlier start first, the longer
 * span first on a tie — so the assignment is stable from week
 * to week for a bar that crosses a week boundary only in that
 * each week packs its own lanes; a bar keeps no lane across
 * weeks. Returns each bar's lane index by bar id, and the lane
 * count the week needs.
 */
export function barLanes(
  bars: { id: string; start: string; end: string }[],
  weekStart: string,
): { laneOf: Map<string, number>; laneCount: number } {
  const sorted = [...bars].sort((a, b) =>
    a.start !== b.start
      ? a.start < b.start
        ? -1
        : 1
      : a.end !== b.end
        ? a.end > b.end
          ? -1
          : 1
        : 0,
  );
  const laneEnds: string[] = [];
  const laneOf = new Map<string, number>();
  for (const bar of sorted) {
    const clampedStart = bar.start < weekStart ? weekStart : bar.start;
    let lane = laneEnds.findIndex((end) => end < clampedStart);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(bar.end);
    } else {
      laneEnds[lane] = bar.end;
    }
    laneOf.set(bar.id, lane);
  }
  return { laneOf, laneCount: laneEnds.length };
}

// ---- week timeline (Issue #44) -------------------------------------

/**
 * The week timeline's axis settings (DESIGN schedule 4.8.1 L5:
 * 縦軸の範囲と目盛りは layout_params で設定でき、時限軸モードも
 * 選べる), read from the view's layout_params:
 * - `axis`: "period" selects the period axis （時限軸モード);
 *   anything else is the clock axis.
 * - `startTime` / `endTime`: "HH:MM" bounds of the clock axis
 *   (a numeric `startHour` / `endHour` reads as that hour). The
 *   defaults are the prototype's 7:00–19:00; an end at or before
 *   the start falls back to the defaults rather than drawing an
 *   empty axis.
 * - `intervalMinutes`: the axis step （目盛り） and the unit a
 *   slot selection covers — 15, 30 or 60, defaulting to 30.
 * The design names the parameters but not their keys; these keys
 * are this implementation's reading of them.
 */
export interface TimelineConfig {
  axis: "time" | "period";
  startMinutes: number;
  endMinutes: number;
  intervalMinutes: number;
}

export function timelineConfig(view: ViewDefinitionData): TimelineConfig {
  const params = view.layoutParams ?? {};
  const timeParam = (key: string, hourKey: string): number | null => {
    const text = params[key];
    if (typeof text === "string" && isValidTimeString(text)) return timeToMinutes(text);
    const hour = params[hourKey];
    if (typeof hour === "number" && Number.isInteger(hour) && hour >= 0 && hour <= 23) {
      return hour * 60;
    }
    return null;
  };
  let startMinutes = timeParam("startTime", "startHour") ?? 7 * 60;
  let endMinutes = timeParam("endTime", "endHour") ?? 19 * 60;
  if (endMinutes <= startMinutes) {
    startMinutes = 7 * 60;
    endMinutes = 19 * 60;
  }
  const interval = params["intervalMinutes"];
  return {
    axis: params["axis"] === "period" ? "period" : "time",
    startMinutes,
    endMinutes,
    intervalMinutes:
      typeof interval === "number" && [15, 30, 60].includes(interval) ? interval : 30,
  };
}

/** "480" minutes after midnight as a padded "08:00" — the shape
 *  a record's clock time is stored in. */
export function minutesToTimeText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** A record's CalendarTime, when it carries one in a known
 *  shape (events and absences both carry `time`). */
function recordTime(record: Record<string, unknown>): CalendarTime | null {
  const time = record["time"];
  if (typeof time !== "object" || time === null) return null;
  const t = time as Record<string, unknown>;
  if (t["kind"] === "all_day") return { kind: "all_day" };
  if (t["kind"] === "half_day" && (t["half"] === "am" || t["half"] === "pm")) {
    return { kind: "half_day", half: t["half"] };
  }
  if (t["kind"] === "clock" && typeof t["startsAt"] === "string") {
    return {
      kind: "clock",
      startsAt: t["startsAt"],
      endsAt: typeof t["endsAt"] === "string" ? t["endsAt"] : null,
    };
  }
  if (t["kind"] === "periods" && typeof t["from"] === "number" && typeof t["to"] === "number") {
    return { kind: "periods", from: t["from"], to: t["to"] };
  }
  return null;
}

/**
 * One band of a day pattern, as the timeline's period axis reads
 * it: every period the pattern carries — the morning band (0)
 * and the after-school band (99) included, where the detail
 * modal's 時限指定 offers only the lesson periods (DESIGN
 * schedule 4.2: period_no 0=朝, 1..N, 99=放課後）. A band always
 * carries its clock times in the master shape; a hand-made
 * record without them keeps nulls and can still be a row, it
 * just cannot place clock-timed entries or seed a clock draft.
 */
export interface DayPeriodBand {
  period: number;
  label: string;
  startsAt: string | null;
  endsAt: string | null;
}

function defaultBandLabel(period: number): string {
  if (period === 0) return "朝";
  if (period === 99) return "放課後";
  return `${period}限`;
}

/** The period bands of the pattern in force on one day: the
 *  day's own day pattern (its dayScheduleId), falling back to
 *  the school's first pattern for a day that names none — the
 *  prototype's reading, and the only pattern a day without a
 *  schedule can be read against. */
export function dayPeriodBands(bootstrap: BootstrapData, day: RangeDayData): DayPeriodBand[] {
  const scheduleId =
    typeof day.day["dayScheduleId"] === "string" ? (day.day["dayScheduleId"] as string) : null;
  const pattern =
    bootstrap.masters.dayPatterns.find((p) => p.id === scheduleId) ??
    bootstrap.masters.dayPatterns[0];
  const periods = pattern?.["periods"];
  if (!Array.isArray(periods)) return [];
  const bands: DayPeriodBand[] = [];
  for (const entry of periods) {
    if (typeof entry !== "object" || entry === null) continue;
    const p = entry as Record<string, unknown>;
    if (typeof p["period"] !== "number") continue;
    const period = p["period"] as number;
    bands.push({
      period,
      label: typeof p["label"] === "string" ? (p["label"] as string) : defaultBandLabel(period),
      startsAt:
        typeof p["startsAt"] === "string" && isValidTimeString(p["startsAt"] as string)
          ? (p["startsAt"] as string)
          : null,
      endsAt:
        typeof p["endsAt"] === "string" && isValidTimeString(p["endsAt"] as string)
          ? (p["endsAt"] as string)
          : null,
    });
  }
  return bands.sort((a, b) => a.period - b.period);
}

/**
 * The period axis's rows for one week: the union of the days'
 * bands, in period order — one day's pattern may differ from
 * another's (a shortened day mid-week), and the axis still has
 * to stand as one set of rows. A row's label and clock times are
 * the first day's band that carries the period.
 */
export function weekPeriodRows(bootstrap: BootstrapData, days: RangeDayData[]): DayPeriodBand[] {
  const byPeriod = new Map<number, DayPeriodBand>();
  for (const day of days) {
    for (const band of dayPeriodBands(bootstrap, day)) {
      if (!byPeriod.has(band.period)) byPeriod.set(band.period, band);
    }
  }
  return [...byPeriod.values()].sort((a, b) => a.period - b.period);
}

/**
 * The clock span (minutes after midnight) one entry occupies on
 * its day, or null when it has no clock placement — an all-day
 * or half-day entry, or a periods entry whose periods the day's
 * pattern does not carry. A periods entry spans its first
 * period's start to its last period's end; a clock entry with
 * no end stands for one hour, the prototype's reading.
 */
export function entryClockSpan(
  record: Record<string, unknown>,
  bands: DayPeriodBand[],
): { start: number; end: number } | null {
  const time = recordTime(record);
  if (!time) return null;
  if (time.kind === "clock") {
    if (!isValidTimeString(time.startsAt)) return null;
    const start = timeToMinutes(time.startsAt);
    const end =
      time.endsAt && isValidTimeString(time.endsAt) ? timeToMinutes(time.endsAt) : start + 60;
    return { start, end: Math.max(end, start + 1) };
  }
  if (time.kind === "periods") {
    const from = bands.find((b) => b.period === time.from);
    const to = bands.find((b) => b.period === time.to) ?? from;
    if (!from?.startsAt || !to?.endsAt) return null;
    return { start: timeToMinutes(from.startsAt), end: timeToMinutes(to.endsAt) };
  }
  return null;
}

/**
 * The period-axis row one entry belongs to on its day, or null
 * when it has no period placement (it then stands in the all-day
 * band): a periods entry in its first period's row; a clock or
 * half-day entry in the first period it overlaps, by the shared
 * derivation (calendarTimeToPeriods) over the day's own pattern
 * — the bands' clock times, the morning and after-school bands
 * included, so an early entry can land in 朝 and a late one in
 * 放課後. This is the 「その日の日課に従って並ぶ」 reading: the
 * pattern is the day's, never the week's first day's.
 */
export function entryPeriod(
  record: Record<string, unknown>,
  bands: DayPeriodBand[],
): number | null {
  const time = recordTime(record);
  if (!time || time.kind === "all_day") return null;
  if (time.kind === "periods") {
    return bands.some((b) => b.period === time.from) ? time.from : null;
  }
  const periodTimes = bands
    .filter((b): b is DayPeriodBand & { startsAt: string; endsAt: string } =>
      Boolean(b.startsAt && b.endsAt),
    )
    .map((b) => ({ period: b.period, startsAt: b.startsAt, endsAt: b.endsAt }));
  const covered = calendarTimeToPeriods(time, periodTimes);
  return covered[0] ?? null;
}

/**
 * Lane assignment for one day's timed blocks (Issue #44): blocks
 * that overlap in time may not share a lane, so each block takes
 * the first lane whose last block has ended by its start — the
 * prototype's side-by-side placement, and the same greedy rule
 * as the calendar grid's barLanes, over minutes instead of
 * dates. Blocks are read in span order (earlier start first, the
 * longer span first on a tie) so the assignment is stable.
 * Returns each block's lane index by id, and the lane count.
 */
export function timeLanes(blocks: { id: string; start: number; end: number }[]): {
  laneOf: Map<string, number>;
  laneCount: number;
} {
  const sorted = [...blocks].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : b.end - a.end,
  );
  const laneEnds: number[] = [];
  const laneOf = new Map<string, number>();
  for (const block of sorted) {
    let lane = laneEnds.findIndex((end) => end <= block.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(block.end);
    } else {
      laneEnds[lane] = block.end;
    }
    laneOf.set(block.id, lane);
  }
  return { laneOf, laneCount: Math.max(1, laneEnds.length) };
}

/** The text of one day_attribute cell: the day's own attributes. */
export function dayAttributeText(day: RangeDayData): string {
  const parts: string[] = [];
  const label = stringField(day.day, "dayTypeLabel");
  const dayType = stringField(day.day, "dayType");
  if (label) parts.push(label);
  else if (dayType && DAY_TYPE_LABELS[dayType]) parts.push(DAY_TYPE_LABELS[dayType] as string);
  const note = stringField(day.day, "note");
  if (note) parts.push(note);
  return parts.join(" ");
}

/** The column's header label. */
export function columnLabel(column: ViewColumnData, bootstrap: BootstrapData): string {
  if (column.sourceKind === "daily_item") {
    return bootstrap.itemDefinitions.find((i) => i.id === column.itemDefinitionId)?.name ?? "項目";
  }
  if (column.sourceKind === "event_category") return "行事";
  if (column.sourceKind === "day_attribute") return "日の種別";
  // A duty column is headed by its definition's own name — the
  // school's word for the duty (日番 / 日直 / 週番…, DESIGN
  // schedule 4.7) — now that getBootstrap returns the definitions
  // (Issue #38). The generic 当番 remains the fallback for a
  // column whose definition is not in the bootstrap.
  return bootstrap.dutyDefinitions.find((d) => d.id === column.dutyDefinitionId)?.name ?? "当番";
}

/** This month's undecided / month-precision events (scenario 9):
 *  the groups whose month is the anchor's month, plus the fully
 *  undecided group (month null), which every month shows. */
/** The school year (April–March) a date belongs to. */
export function schoolYearOf(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

/**
 * The window the confirmation queue reads pending events over
 * (Issue #39): the previous, current and next school years,
 * whole. The platform's range read matches an undecided event
 * only when the range covers its whole school year, so the
 * window is built from school years, not from days around
 * today; a tentative event outside these three years is not in
 * the queue (it still shows in its month table, as tentative).
 */
export function pendingRange(today: string): { from: string; to: string } {
  const year = schoolYearOf(today);
  return { from: `${year - 1}-04-01`, to: `${year + 2}-03-31` };
}

export function undecidedForMonth(range: RangeData, anchor: string): Record<string, unknown>[] {
  const month = anchor.slice(0, 7);
  const out: Record<string, unknown>[] = [];
  for (const group of range.undecided) {
    if (group.month === month || group.month === null) out.push(...group.events);
  }
  return out;
}

export type { RangeData };

// ---- cell input (Issue #35) ----------------------------------------

/**
 * Name matching for person-led entries, ported from the prototype's
 * server/src/logic.ts: names compare equal once every blank —
 * half-width or full-width — is removed. The prototype compared
 * typed text against the people list exactly this way; DESIGN
 * schedule 6.4 keeps direct typing and list choice side by side,
 * and a typed name that matches nobody stays free text (6.3.1).
 */
export function normalizeName(name: string): string {
  return name.replace(/[\s\u3000]/g, "");
}

/** The staff member a typed name refers to, or null when no staff
 *  name matches after blank-stripping. */
export function matchStaffByName(name: string, staff: MasterEntry[]): MasterEntry | null {
  const wanted = normalizeName(name);
  if (wanted === "") return null;
  return staff.find((s) => typeof s.name === "string" && normalizeName(s.name) === wanted) ?? null;
}

/** The kind template of one subject kind and kind code, if the
 *  school has one (getBootstrap returns them sorted by sort). */
export function templateForKind(
  bootstrap: BootstrapData,
  subjectKind: "event" | "absence",
  kindCode: string,
): KindTemplateData | null {
  return (
    bootstrap.kindTemplates.find((t) => t.subjectKind === subjectKind && t.kindCode === kindCode) ??
    null
  );
}

/** A staff member's display name (the id itself when unknown). */
export function staffNameOf(bootstrap: BootstrapData, staffId: string): string {
  return bootstrap.masters.staff.find((s) => s.id === staffId)?.name ?? staffId;
}

/**
 * The absence kind template a provisional entry belongs to, if
 * the record is one (PR #75 review, 推奨 3): an entry typed into
 * a trip / leave column that is not (yet) a real absence — a
 * placeholder name standing in for the person, or a trip known
 * only by its title — is held as an event of kind "other" whose
 * kindLabel names the absence template it was typed under (see
 * buildFreeTextEntry / buildTitleOnlyEntry in cells.tsx). It is
 * not an absence, so it never takes part in duty-conflict
 * derivation (#31); it becomes one only when the placeholder is
 * rewritten with a roster name.
 */
export function provisionalTemplateOf(
  event: Record<string, unknown>,
  bootstrap: BootstrapData,
): KindTemplateData | null {
  if (stringField(event, "kind") !== "other") return null;
  const label = stringField(event, "kindLabel");
  if (!label) return null;
  return (
    bootstrap.kindTemplates.find((t) => t.subjectKind === "absence" && t.name === label) ?? null
  );
}

/** The free-text person name a provisional entry carries, if it
 *  carries one (the placeholder-name shape); a title-only entry
 *  has no free-text assignee. */
export function freeTextNameOf(event: Record<string, unknown>): string | null {
  const assignees = event["assignees"];
  if (!Array.isArray(assignees)) return null;
  for (const assignee of assignees) {
    if (typeof assignee !== "object" || assignee === null) continue;
    const record = assignee as Record<string, unknown>;
    if (record["kind"] === "free_text" && typeof record["name"] === "string") {
      return record["name"];
    }
  }
  return null;
}

/** How a provisional entry reads in its own column: the
 *  placeholder name exactly as typed — no kind suffix — or, for
 *  a title-only entry, the title itself. */
export function provisionalLineText(event: Record<string, unknown>): string {
  return freeTextNameOf(event) ?? eventTitle(event);
}

/**
 * The cell line of one absence record, led the way its kind
 * template prescribes (DESIGN schedule 6.3.1): a leave is led by
 * the holder's name with its classification in brackets — 「取得者名
 * （分類）」 — and a trip shows the person's name together with the
 * trip's purpose. A record in the restricted shape (no purpose
 * field, the leave privacy rule) simply shows less.
 */
export function absenceLineText(
  absence: Record<string, unknown>,
  bootstrap: BootstrapData,
): string {
  const staffId = stringField(absence, "staffId");
  const name = staffId ? staffNameOf(bootstrap, staffId) : "（不明）";
  const kind = stringField(absence, "kind") ?? "";
  const template = templateForKind(bootstrap, "absence", kind);
  const purpose = stringField(absence, "purpose");
  if (template?.displaySource === "person") {
    const subdivision = stringField(absence, "subdivisionKey");
    if (!subdivision) return name;
    // The bracket shows the school's word for the classification,
    // not the stored key (Issue #36): the platform's subdivision
    // definitions ride along in the bootstrap for exactly this.
    const label =
      bootstrap.absenceSubdivisions.find((s) => s.code === kind && s.key === subdivision)?.label ??
      subdivision;
    return `${name}（${label}）`;
  }
  if (template?.displaySource === "person_title") {
    return purpose ? `${name} ${purpose}` : name;
  }
  return purpose ?? name;
}

/** The daily value of one item for one axis target, if set. */
export function dailyValueForTarget(
  day: RangeDayData,
  item: ItemDefinitionData,
  targetId: string,
): DailyValueData | undefined {
  return day.dailyValues.find(
    (v) =>
      v.itemDefinitionId === item.id && (v.targetId === targetId || v.targetRef?.id === targetId),
  );
}

/** The daily value of one item with no target, if set. */
export function plainDailyValue(
  day: RangeDayData,
  item: ItemDefinitionData,
): DailyValueData | undefined {
  return day.dailyValues.find(
    (v) => v.itemDefinitionId === item.id && v.targetId === null && v.targetRef === null,
  );
}

/** The write-side target reference for one axis entry of an item:
 *  an app-axis member names its target group; a platform-axis
 *  member names the axis itself (schedule/src/dailyValues/types). */
export function targetRefForTarget(
  item: ItemDefinitionData,
  bootstrap: BootstrapData,
  targetId: string,
): TargetRefData | null {
  if (item.targetGroupId) {
    const group = bootstrap.targetGroups.find((g) => g.id === item.targetGroupId);
    if (!group) return null;
    return { axis: "app", app: "schedule", axisKey: group.key, id: targetId };
  }
  if (item.targetPlatformAxis) {
    const axis = item.targetPlatformAxis;
    if (
      axis === "grade" ||
      axis === "class" ||
      axis === "special_needs_class" ||
      axis === "staff" ||
      axis === "room"
    ) {
      return { axis, id: targetId };
    }
  }
  return null;
}
