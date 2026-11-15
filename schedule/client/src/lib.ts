import {
  addDays,
  datesInRange,
  formatGroupedValues,
  weekdayOf,
} from "@school-manage/calendar-types";
import type {
  BootstrapData,
  DailyValueData,
  DutyConflictData,
  ItemDefinitionData,
  RangeData,
  RangeDayData,
  TargetGroupData,
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

/** The [from, to] a view asks getRange for, from the anchor date. */
export function rangeFor(view: ViewDefinitionData, anchor: string): { from: string; to: string } {
  if (view.layout === "week_rows") {
    const from = weekStartOf(anchor);
    return { from, to: addDays(from, weekSpanOf(view) - 1) };
  }
  // month_rows (and any other layout shown as rows for now)
  return { from: monthStartOf(anchor), to: monthEndOf(anchor) };
}

/** Step the anchor by one period of the view's layout. */
export function stepAnchor(view: ViewDefinitionData, anchor: string, dir: 1 | -1): string {
  if (view.layout === "week_rows") return addDays(anchor, dir * weekSpanOf(view));
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
function axisEntries(
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
export function undecidedForMonth(range: RangeData, anchor: string): Record<string, unknown>[] {
  const month = anchor.slice(0, 7);
  const out: Record<string, unknown>[] = [];
  for (const group of range.undecided) {
    if (group.month === month || group.month === null) out.push(...group.events);
  }
  return out;
}

export type { RangeData };
