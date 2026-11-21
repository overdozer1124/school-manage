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

/** The [from, to] a view asks getRange for, from the anchor date. */
export function rangeFor(view: ViewDefinitionData, anchor: string): { from: string; to: string } {
  if (view.layout === "week_rows") {
    const from = weekStartOf(anchor);
    return { from, to: addDays(from, weekSpanOf(view) - 1) };
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
  if (view.layout === "year_columns") return addMonths(anchor, dir * 12);
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
