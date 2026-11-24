import { formatGroupedValues, weekdayOf } from "@school-manage/calendar-types";
import type { DefinitionSet } from "../db/definitions.js";
import type { DutyDefinitionWithRule } from "../db/duties.js";
import type {
  DailyValueRow,
  ItemDefinitionRow,
  KindTemplateRow,
  PublicationPrintSettings,
  ViewColumnRow,
} from "../db/schema.js";
import type { RangeDay, RangeResult } from "../range/types.js";

/**
 * The print renderer (Issue #40): turns one getRange bundle — the
 * same bundle the screen's L1 table is drawn from — into the
 * self-contained HTML document a publication stores. It is a
 * server-side mirror of the screens' display rules (client/src/
 * lib.ts and the entry cells' read side): the same column labels,
 * the same entry lines (events led by their time, absences led
 * the way their kind template prescribes, DESIGN schedule
 * 6.3.1), the same same-value grouping for target-split items
 * (4.8.2, through the shared pure function), and the same day
 * marks — Saturdays blue, Sundays and holidays red, with the
 * weekday letter and the holiday / day-type name always printed
 * alongside, so colour is never the only signal (9.1).
 *
 * What the range does not contain cannot appear here: getRange
 * has already applied the view's audience filter (a guardian
 * view's bundle holds no staff-only items, no duties and no
 * absences), so a guardian publication is clean by construction,
 * not by a second filter in this module. A two_column view
 * (Issue #46) renders as its paper form — the month in two
 * half-month tables side by side, headed by the month's
 * accompanying notes from the same bundle. Two screen decorations
 * are deliberately not printed: the duty conflict warnings
 * (derived alerts for the people working the table, not part of
 * the issued record) — the （交代） mark stays, because it states
 * what the assignment is, not that something needs attention.
 *
 * The structured snapshot a publication stores beside its
 * document (Issue #48, snapshot.ts) is built from this same
 * input through cellText below, so the version diffs compare
 * exactly the texts this renderer prints.
 */

type Record_ = Record<string, unknown>;

export interface PrintContext {
  itemDefinitions: DefinitionSet["itemDefinitions"];
  targetGroups: DefinitionSet["targetGroups"];
  kindTemplates: KindTemplateRow[];
  dutyDefinitions: DutyDefinitionWithRule[];
  absenceSubdivisions: Record_[];
  staff: Record_[];
  grades: Record_[];
  dayPatterns: Record_[];
}

export interface RenderPublicationInput {
  schoolName: string | null;
  viewName: string;
  targetMonth: string;
  versionLabel: string;
  publishedAt: Date;
  range: RangeResult;
  printSettings: PublicationPrintSettings;
  context: PrintContext;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stringField(record: Record_, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

const WEEKDAY_LABELS: Record<string, string> = {
  sun: "日",
  mon: "月",
  tue: "火",
  wed: "水",
  thu: "木",
  fri: "金",
  sat: "土",
};

function weekdayLabel(date: string): string {
  return WEEKDAY_LABELS[weekdayOf(date)] ?? "";
}

const DAY_TYPE_LABELS: Record<string, string> = {
  class_day: "",
  event_day: "行事日",
  exam_day: "試験日",
  closed_day: "休業日",
  long_vacation: "長期休業",
  make_up_day: "振替授業日",
};

interface DayMark {
  kind: "sat" | "sun" | "holiday" | "";
  sub: string;
  closed: boolean;
}

/** The day's mark, as the screen computes it (client/src/lib.ts
 *  dayMark): the holiday names and day-type words are the
 *  non-colour signal a monochrome print keeps. */
function dayMark(day: RangeDay, ctx: PrintContext): DayMark {
  const weekday = weekdayOf(day.date);
  const holidayNames = day.holidays
    .map((h) => stringField(h, "name"))
    .filter((n): n is string => n !== null);
  const isHoliday = holidayNames.length > 0;
  const dayType = stringField(day.day, "dayType");
  const parts: string[] = [...holidayNames];
  if (dayType && DAY_TYPE_LABELS[dayType]) parts.push(DAY_TYPE_LABELS[dayType] as string);
  const label = stringField(day.day, "dayTypeLabel");
  if (label) parts.push(label);
  const scheduleId = stringField(day.day, "dayScheduleId");
  if (scheduleId) {
    const pattern = ctx.dayPatterns.find((p) => p["id"] === scheduleId);
    const code = pattern ? stringField(pattern, "code") : null;
    if (code) parts.push(`${code}日課`);
  }
  return {
    kind: isHoliday || weekday === "sun" ? "holiday" : weekday === "sat" ? "sat" : "",
    sub: parts.join(" "),
    closed:
      dayType === "closed_day" || dayType === "long_vacation" || isHoliday || weekday === "sun",
  };
}

function eventTitle(event: Record_): string {
  return stringField(event, "title") ?? stringField(event, "kindLabel") ?? "（無題）";
}

function eventTimeText(event: Record_): string {
  const time = event["time"];
  if (typeof time !== "object" || time === null) return "";
  const t = time as Record_;
  if (t["kind"] === "clock" && typeof t["startsAt"] === "string") {
    return typeof t["endsAt"] === "string"
      ? `${t["startsAt"]}〜${t["endsAt"]} `
      : `${t["startsAt"]} `;
  }
  if (t["kind"] === "half_day") return t["half"] === "pm" ? "午後 " : "午前 ";
  return "";
}

function staffName(ctx: PrintContext, personId: string | null): string {
  if (!personId) return "（未定）";
  const found = ctx.staff.find((s) => s["id"] === personId);
  return (found && stringField(found, "name")) ?? personId;
}

function templateForKind(
  ctx: PrintContext,
  subjectKind: "event" | "absence",
  kindCode: string,
): KindTemplateRow | null {
  return (
    ctx.kindTemplates.find((t) => t.subjectKind === subjectKind && t.kindCode === kindCode) ?? null
  );
}

/** A provisional entry's absence template, when the record is
 *  one (Issue #35): an event of kind "other" whose kindLabel
 *  names the absence template it was typed under. */
function provisionalTemplateOf(event: Record_, ctx: PrintContext): KindTemplateRow | null {
  if (stringField(event, "kind") !== "other") return null;
  const label = stringField(event, "kindLabel");
  if (!label) return null;
  return ctx.kindTemplates.find((t) => t.subjectKind === "absence" && t.name === label) ?? null;
}

function freeTextNameOf(event: Record_): string | null {
  const assignees = event["assignees"];
  if (!Array.isArray(assignees)) return null;
  for (const assignee of assignees) {
    if (typeof assignee !== "object" || assignee === null) continue;
    const record = assignee as Record_;
    if (record["kind"] === "free_text" && typeof record["name"] === "string") {
      return record["name"];
    }
  }
  return null;
}

function provisionalLineText(event: Record_): string {
  return freeTextNameOf(event) ?? eventTitle(event);
}

/** The absence templates whose provisional entries a sibling
 *  column of the same view claims as its own (the entry cells'
 *  rule): the event column leaves a claimed provisional to its
 *  own column, so nothing prints twice. */
function claimedProvisionalLabels(
  column: ViewColumnRow,
  columns: ViewColumnRow[],
  ctx: PrintContext,
): Set<string> {
  const claimed = new Set<string>();
  for (const sibling of columns) {
    if (sibling.id === column.id || sibling.sourceKind !== "daily_item") continue;
    const item = ctx.itemDefinitions.find((i) => i.id === sibling.itemDefinitionId);
    if (!item || item.valueType !== "event_list") continue;
    if (item.key === "staff_movement") {
      for (const t of ctx.kindTemplates) {
        if (t.subjectKind === "absence") claimed.add(t.name);
      }
      continue;
    }
    const bound =
      ctx.kindTemplates.find((t) => t.key === item.key || t.kindCode === item.key) ?? null;
    if (bound?.subjectKind === "absence") claimed.add(bound.name);
  }
  return claimed;
}

/** One absence's line, led the way its kind template prescribes
 *  (DESIGN schedule 6.3.1), exactly as the screen's absenceLineText
 *  composes it — including the subdivision's label in place of
 *  its stored key, and the restricted shape simply showing less. */
function absenceLineText(absence: Record_, ctx: PrintContext): string {
  const staffId = stringField(absence, "staffId");
  const name = staffId ? staffName(ctx, staffId) : "（不明）";
  const kind = stringField(absence, "kind") ?? "";
  const template = templateForKind(ctx, "absence", kind);
  const purpose = stringField(absence, "purpose");
  if (template?.displaySource === "person") {
    const subdivision = stringField(absence, "subdivisionKey");
    if (!subdivision) return name;
    const found = ctx.absenceSubdivisions.find(
      (s) => s["code"] === kind && s["key"] === subdivision,
    );
    const label = (found && stringField(found, "label")) ?? subdivision;
    return `${name}（${label}）`;
  }
  if (template?.displaySource === "person_title") {
    return purpose ? `${name} ${purpose}` : name;
  }
  return purpose ?? name;
}

/**
 * The lines of one entry column (an event_category column, or a
 * daily_item column whose item is an event list): which records
 * the column shows follows the entry cells' plan — the event
 * column shows the day's events and absences, 職員動静 shows the
 * absences and every absence kind's provisionals, a column bound
 * to one template shows that kind's records.
 */
function entryLines(
  day: RangeDay,
  column: ViewColumnRow,
  columns: ViewColumnRow[],
  ctx: PrintContext,
): string[] {
  const lines = (events: Record_[], absences: Record_[], absenceFamily: boolean): string[] => [
    ...events.map(
      (e) =>
        `${eventTimeText(e)}${absenceFamily && provisionalTemplateOf(e, ctx) ? provisionalLineText(e) : eventTitle(e)}`,
    ),
    ...absences.map((a) => absenceLineText(a, ctx)),
  ];
  if (column.sourceKind === "event_category") {
    const claimed = claimedProvisionalLabels(column, columns, ctx);
    return lines(
      day.events.filter((e) => {
        const provisional = provisionalTemplateOf(e, ctx);
        return !provisional || !claimed.has(provisional.name);
      }),
      day.absences,
      false,
    );
  }
  const item = ctx.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
  if (!item || item.valueType !== "event_list") return [];
  if (item.key === "staff_movement") {
    return lines(
      day.events.filter((e) => provisionalTemplateOf(e, ctx) !== null),
      day.absences,
      true,
    );
  }
  const bound =
    ctx.kindTemplates.find((t) => t.key === item.key || t.kindCode === item.key) ?? null;
  if (bound) {
    return lines(
      bound.subjectKind === "event"
        ? day.events.filter((e) => e["kind"] === bound.kindCode)
        : day.events.filter((e) => provisionalTemplateOf(e, ctx)?.key === bound.key),
      bound.subjectKind === "absence"
        ? day.absences.filter((a) => a["kind"] === bound.kindCode)
        : [],
      bound.subjectKind === "absence",
    );
  }
  return lines(
    day.events.filter((e) => e["kind"] === "event"),
    [],
    false,
  );
}

function dailyValueText(
  value: DailyValueRow,
  item: DefinitionSet["itemDefinitions"][number],
): string {
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

function targetNameOf(value: DailyValueRow, ctx: PrintContext): string | null {
  if (value.targetRef) {
    if (value.targetRef.axis === "grade") {
      const grade = ctx.grades.find((g) => g["id"] === value.targetRef?.id);
      return (grade && stringField(grade, "name")) ?? null;
    }
    if (value.targetRef.axis === "app") {
      for (const group of ctx.targetGroups) {
        const target = group.targets.find((t) => t.id === value.targetRef?.id);
        if (target) return target.name;
      }
      return null;
    }
    return null;
  }
  if (value.targetId) {
    for (const group of ctx.targetGroups) {
      const target = group.targets.find((t) => t.id === value.targetId);
      if (target) return target.name;
    }
    return null;
  }
  return null;
}

function axisEntries(item: ItemDefinitionRow, ctx: PrintContext): { id: string; name: string }[] {
  if (item.targetGroupId) {
    const group = ctx.targetGroups.find((g) => g.id === item.targetGroupId);
    return (group?.targets ?? []).map((t) => ({ id: t.id, name: t.name }));
  }
  if (item.targetPlatformAxis === "grade") {
    return ctx.grades
      .map((g) => ({
        id: typeof g["id"] === "string" ? (g["id"] as string) : "",
        name: stringField(g, "name") ?? (typeof g["id"] === "string" ? (g["id"] as string) : ""),
      }))
      .filter((e) => e.id !== "");
  }
  return [];
}

/** One daily_item cell's text, with the 4.8.2 grouping — the
 *  screen's dailyCellText rule, unchanged. */
function dailyCellText(day: RangeDay, column: ViewColumnRow, ctx: PrintContext): string {
  const item = ctx.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
  if (!item) return "";
  const values = day.dailyValues.filter((v) => v.itemDefinitionId === item.id);
  if (values.length === 0) return "";
  const plain = values.filter((v) => targetNameOf(v, ctx) === null);
  const targeted = values.filter((v) => targetNameOf(v, ctx) !== null);
  const parts: string[] = plain.map((v) => dailyValueText(v, item));
  if (targeted.length > 0) {
    const byTarget = new Map<string, string>();
    for (const v of targeted) {
      const name = targetNameOf(v, ctx);
      if (name) byTarget.set(name, dailyValueText(v, item));
    }
    const entries = axisEntries(item, ctx)
      .filter((e) => byTarget.has(e.name))
      .map((e) => ({ name: e.name, value: byTarget.get(e.name) ?? null }));
    const known = new Set(entries.map((e) => e.name));
    for (const [name, text] of byTarget) {
      if (!known.has(name)) entries.push({ name, value: text });
    }
    parts.push(formatGroupedValues(entries, { groupSameValues: column.groupSameValues }));
  }
  return parts.filter((p) => p !== "").join("／");
}

/** One duty cell's lines: the holders by slot, with the （交代）
 *  mark of an assignment a change was applied to. */
function dutyLines(day: RangeDay, column: ViewColumnRow, ctx: PrintContext): string[] {
  const slotOrder = ["am", "pm", "all_day", "week"];
  const assignments = [...day.dutyAssignments]
    .filter((a) => a.dutyDefinitionId === column.dutyDefinitionId)
    .sort((a, b) => slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot));
  return assignments.map((a) => {
    const prefix = a.slot === "am" ? "午前 " : a.slot === "pm" ? "午後 " : "";
    return `${prefix}${staffName(ctx, a.personId)}${a.origin === "swap" ? "（交代）" : ""}`;
  });
}

function dayAttributeText(day: RangeDay): string {
  const parts: string[] = [];
  const label = stringField(day.day, "dayTypeLabel");
  const dayType = stringField(day.day, "dayType");
  if (label) parts.push(label);
  else if (dayType && DAY_TYPE_LABELS[dayType]) parts.push(DAY_TYPE_LABELS[dayType] as string);
  const note = stringField(day.day, "note");
  if (note) parts.push(note);
  return parts.join(" ");
}

export function columnLabel(column: ViewColumnRow, ctx: PrintContext): string {
  if (column.sourceKind === "daily_item") {
    return ctx.itemDefinitions.find((i) => i.id === column.itemDefinitionId)?.name ?? "項目";
  }
  if (column.sourceKind === "event_category") return "行事";
  if (column.sourceKind === "day_attribute") return "日の種別";
  return ctx.dutyDefinitions.find((d) => d.id === column.dutyDefinitionId)?.name ?? "当番";
}

function cellHtml(
  day: RangeDay,
  column: ViewColumnRow,
  columns: ViewColumnRow[],
  ctx: PrintContext,
): string {
  if (column.sourceKind === "event_category") {
    return entryLines(day, column, columns, ctx)
      .map((line) => `<div>${esc(line)}</div>`)
      .join("");
  }
  if (column.sourceKind === "daily_item") {
    const item = ctx.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
    if (item?.valueType === "event_list") {
      return entryLines(day, column, columns, ctx)
        .map((line) => `<div>${esc(line)}</div>`)
        .join("");
    }
    return esc(dailyCellText(day, column, ctx));
  }
  if (column.sourceKind === "duty") {
    return dutyLines(day, column, ctx)
      .map((line) => `<div>${esc(line)}</div>`)
      .join("");
  }
  return esc(dayAttributeText(day));
}

/**
 * One cell's text as printed (Issue #48): the same lines
 * cellHtml wraps in the document — composed by the same
 * entryLines / dailyCellText / dutyLines / dayAttributeText, so
 * the snapshot's text cannot drift from the document's — joined
 * by newlines into the one string the version diff compares.
 */
export function cellText(
  day: RangeDay,
  column: ViewColumnRow,
  columns: ViewColumnRow[],
  ctx: PrintContext,
): string {
  if (column.sourceKind === "event_category") {
    return entryLines(day, column, columns, ctx).join("\n");
  }
  if (column.sourceKind === "daily_item") {
    const item = ctx.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
    if (item?.valueType === "event_list") {
      return entryLines(day, column, columns, ctx).join("\n");
    }
    return dailyCellText(day, column, ctx);
  }
  if (column.sourceKind === "duty") {
    return dutyLines(day, column, ctx).join("\n");
  }
  return dayAttributeText(day);
}

const FONT_SIZES: Record<PublicationPrintSettings["fontScale"], string> = {
  small: "9px",
  medium: "10.5px",
  large: "12px",
};

/**
 * Renders the issued document. The @page rule carries the print
 * settings (paper, orientation, margins) and the page-number
 * footer (DESIGN schedule 9.1); the header block carries the
 * school name, the month and the version label, so any printed
 * copy names the version it belongs to.
 */
export function renderPublicationDocument(input: RenderPublicationInput): string {
  const { range, printSettings, context: ctx } = input;
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  const monthText = `${input.targetMonth.slice(0, 4)}年${Number(input.targetMonth.slice(5, 7))}月`;
  const publishedText = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(input.publishedAt);
  const schoolName = input.schoolName ?? "行事予定";

  const head = columns
    .map(
      (column) =>
        `<th scope="col"${column.widthHint ? ` style="width:${column.widthHint}px"` : ""}>${esc(columnLabel(column, ctx))}</th>`,
    )
    .join("");
  const tableHtml = (days: RangeDay[]): string => {
    const rows = days
      .map((day) => {
        const mark = dayMark(day, ctx);
        const cells = columns
          .map((column) => `<td>${cellHtml(day, column, columns, ctx)}</td>`)
          .join("");
        return `<tr${mark.closed ? ' class="closed"' : ""}><th scope="row" class="date-cell kind-${mark.kind}"><span class="date-num">${Number(day.date.slice(8, 10))}</span> <span class="date-weekday">（${weekdayLabel(day.date)}）</span>${mark.sub ? `<span class="date-sub">${esc(mark.sub)}</span>` : ""}</th>${cells}</tr>`;
      })
      .join("\n");
    return `<table>
<thead><tr><th scope="col" class="date-cell">日</th>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  };

  // The two-column layout (Issue #46): the month stands as two
  // half-month tables side by side — the paper form of the
  // student table — and the month's accompanying notes （生活
  // 目標・健康目標） head the document, as they head the screen.
  // Every other layout keeps the single table it has always had,
  // and the notes stay a two-column header: they are the student
  // table's accompanying information.
  const twoColumn = range.view.layout === "two_column";
  let monthNotesHtml = "";
  let tableSection: string;
  if (twoColumn) {
    const note = range.monthNotes.find((n) => n.month === input.targetMonth) ?? null;
    const goals: string[] = [];
    if (note?.lifeGoal)
      goals.push(`<div><span class="goal-label">生活目標</span>${esc(note.lifeGoal)}</div>`);
    if (note?.healthGoal)
      goals.push(`<div><span class="goal-label">健康目標</span>${esc(note.healthGoal)}</div>`);
    monthNotesHtml =
      goals.length > 0 ? `<section class="month-notes">${goals.join("")}</section>` : "";
    const half = Math.ceil(range.days.length / 2);
    tableSection = `<div class="two-column">${tableHtml(range.days.slice(0, half))}${tableHtml(range.days.slice(half))}</div>`;
  } else {
    tableSection = tableHtml(range.days);
  }

  const undecided = range.undecided.filter(
    (group) => group.month === input.targetMonth || group.month === null,
  );
  const undecidedHtml =
    undecided.length > 0
      ? `<section class="undecided"><h2>その月の未定</h2><ul>${undecided
          .flatMap((group) =>
            group.events.map(
              (event) =>
                `<li>${esc(eventTitle(event))}（${event["datePrecision"] === "undecided" ? "時期未定" : "月のみ確定"}）</li>`,
            ),
          )
          .join("")}</ul></section>`
      : "";

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${esc(schoolName)} ${esc(monthText)} 行事予定表（${esc(input.versionLabel)}）</title>
<style>
@page {
  size: ${printSettings.paper} ${printSettings.orientation};
  margin: ${printSettings.marginMm}mm;
  @bottom-center { content: counter(page) " / " counter(pages); font-size: 9px; color: #555; }
}
body { font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans CJK JP", "Yu Gothic", sans-serif; font-size: ${FONT_SIZES[printSettings.fontScale]}; color: #111; margin: 0; }
header.print-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 6px; }
header.print-head h1 { font-size: 1.5em; margin: 0; }
header.print-head .meta { text-align: right; white-space: nowrap; }
table { border-collapse: collapse; width: 100%; }
.two-column { display: flex; gap: 12px; align-items: flex-start; }
.two-column table { flex: 1 1 0; }
section.month-notes { border: 1px solid #999; padding: 4px 8px; margin-bottom: 6px; display: flex; flex-direction: column; gap: 2px; }
section.month-notes .goal-label { font-weight: 600; margin-right: 8px; }
th, td { border: 1px solid #999; padding: 2px 4px; vertical-align: top; text-align: left; }
thead th { background: #eee; }
tr.closed { background: #f3f4f6; }
.date-cell { white-space: nowrap; width: 92px; }
.date-num { font-weight: 600; }
.kind-sat .date-num, .kind-sat .date-weekday { color: #2563eb; }
.kind-holiday .date-num, .kind-holiday .date-weekday { color: #b91c1c; }
.date-sub { display: block; font-size: 0.85em; color: #555; white-space: normal; }
section.undecided { margin-top: 10px; }
section.undecided h2 { font-size: 1.1em; margin: 0 0 4px; }
section.undecided ul { margin: 0; padding-left: 18px; }
</style>
</head>
<body>
<header class="print-head">
<h1>${esc(schoolName)} ${esc(monthText)} 行事予定表</h1>
<div class="meta"><div>${esc(input.viewName)}</div><div>版：${esc(input.versionLabel)}</div><div>発行：${esc(publishedText)}</div></div>
</header>
${monthNotesHtml}
${tableSection}
${undecidedHtml}
</body>
</html>
`;
}
