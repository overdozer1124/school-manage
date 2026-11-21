import { useMemo, useState } from "react";
import type { CellEditorContext } from "./cells";
import { DayDetail } from "./DayDetail";
import { DetailModal, type DetailTarget } from "./DetailModal";
import {
  absenceLineText,
  absenceSpan,
  barLanes,
  dailyCellText,
  dayMark,
  eventSpan,
  eventTimeText,
  eventTitle,
  provisionalLineText,
  provisionalTemplateOf,
  templateForKind,
  weekdayLabel,
} from "./lib";
import type { BootstrapData, RangeData, RangeDayData } from "./types";

/**
 * The L4 calendar grid (calendar_grid, Issue #43; DESIGN
 * schedule 4.8.1): a month folded at the week — weeks are rows,
 * the seven weekdays are columns, and the week's first weekday
 * is the view's setting (lib's gridWeekStart). The range is the
 * month padded to whole weeks (lib's calendarGridRange), so the
 * days at the edges belong to the neighbouring months and are
 * drawn dimmed.
 *
 * A day cell holds a capped number of entry lines — the cap is
 * the prototype's three — and the rest reads as 「他○件」.
 * Entries spanning more than one day are not lines: they are
 * period bars, drawn in lanes above the week's cells and
 * connected across the days they cover (a bar that runs over a
 * week boundary is drawn again in the next week's lanes, cut at
 * the boundary). Clicking a bar or a line opens the entry's
 * detail modal, exactly as in the rows tables (4.8.1: 予定
 * オブジェクトのクリックでモーダルが開く点も共通）; clicking
 * the cell itself opens the day's detail — one day of the rows
 * table (DayDetail) — which is also where input starts: the
 * design's L4 input is 「日マスを選んで入力開始」, not typing
 * into the cell, and from there the flow is the other layouts'
 * (entry creation, the quick popover, the modal).
 *
 * What a cell shows follows the view's columns, narrowed the
 * way the prototype narrowed its grid: the day's entries (the
 * server has already applied the view's audience filter to the
 * bundle) and, as one compact line each, the symbol / boolean
 * daily items among the view's columns — the kinds that read
 * at a glance （給食 ○). The longer daily values, the duties
 * and the day attributes live in the day detail, which draws
 * every column the view carries.
 */
export const MAX_CELL_ENTRIES = 3;

interface GridEntry {
  subjectKind: "event" | "absence";
  record: Record<string, unknown>;
  text: string;
  start: string;
  end: string;
  multi: boolean;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function revisionOf(record: Record<string, unknown>): number | null {
  const value = record["revision"];
  return typeof value === "number" ? value : null;
}

/** Every entry of the range, deduplicated by record: a spanning
 *  entry stands in each of its days' lists, and the bars are
 *  built from the records themselves, once each. */
function allEntries(range: RangeData, bootstrap: BootstrapData): GridEntry[] {
  const byId = new Map<string, GridEntry>();
  const add = (entry: GridEntry) => {
    const id = stringField(entry.record, "id") ?? `${entry.start}|${entry.text}`;
    if (!byId.has(id)) byId.set(id, entry);
  };
  for (const day of range.days) {
    for (const event of day.events) {
      const span = eventSpan(event);
      if (!span) continue;
      add({
        subjectKind: "event",
        record: event,
        text: provisionalTemplateOf(event, bootstrap)
          ? provisionalLineText(event)
          : `${eventTimeText(event)}${eventTitle(event)}`,
        start: span.start,
        end: span.end,
        multi: span.end > span.start,
      });
    }
    for (const absence of day.absences) {
      const span = absenceSpan(absence);
      if (!span) continue;
      add({
        subjectKind: "absence",
        record: absence,
        text: absenceLineText(absence, bootstrap),
        start: span.start,
        end: span.end,
        multi: span.end > span.start,
      });
    }
  }
  return [...byId.values()];
}

/** One day's single-day entries, in the rows table's order —
 *  the day's events as the bundle lists them, then its
 *  absences. The spanning entries are the bars, not lines. */
function dayLines(day: RangeDayData, bootstrap: BootstrapData): GridEntry[] {
  const lines: GridEntry[] = [];
  for (const event of day.events) {
    const span = eventSpan(event);
    if (!span || span.end > span.start) continue;
    lines.push({
      subjectKind: "event",
      record: event,
      text: provisionalTemplateOf(event, bootstrap)
        ? provisionalLineText(event)
        : `${eventTimeText(event)}${eventTitle(event)}`,
      start: span.start,
      end: span.end,
      multi: false,
    });
  }
  for (const absence of day.absences) {
    const span = absenceSpan(absence);
    if (!span || span.end > span.start) continue;
    lines.push({
      subjectKind: "absence",
      record: absence,
      text: absenceLineText(absence, bootstrap),
      start: span.start,
      end: span.end,
      multi: false,
    });
  }
  return lines;
}

export function CalendarGrid({
  bootstrap,
  range,
  anchor,
  editor,
}: {
  bootstrap: BootstrapData;
  range: RangeData;
  /** The month the grid is showing (its padding days belong to
   *  the neighbouring months and are drawn dimmed). */
  anchor: string;
  editor?: CellEditorContext;
}) {
  const [detailDate, setDetailDate] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  const byDate = useMemo(() => new Map(range.days.map((day) => [day.date, day])), [range]);
  const entries = useMemo(() => allEntries(range, bootstrap), [range, bootstrap]);
  const weeks = useMemo(() => {
    const dates = range.days.map((day) => day.date);
    const out: string[][] = [];
    for (let i = 0; i < dates.length; i += 7) out.push(dates.slice(i, i + 7));
    return out;
  }, [range]);

  const month = anchor.slice(0, 7);
  const isViewer = bootstrap.role === "Viewer";

  /** Whether an entry may open its detail modal from the grid,
   *  under the same rule as the entry cells (cells.tsx): a
   *  settled record the caller may change — a Viewer only their
   *  own absences, and a restricted-shape absence (another
   *  person's leave, its hidden texts not in the record) never,
   *  because the modal would rewrite it from what is shown. */
  const canOpen = (entry: GridEntry): boolean => {
    if (!editor) return false;
    if (revisionOf(entry.record) === null) return false;
    if (isViewer) {
      return entry.subjectKind === "absence" && entry.record["staffId"] === bootstrap.teacherId;
    }
    return entry.subjectKind === "event" || "purpose" in entry.record;
  };

  /** Opens the detail modal on one entry, framed by its kind
   *  template — the entry cells' resolution (cells.tsx): a
   *  provisional entry by the absence template it stands in
   *  for, any other by the template of its kind. */
  const openDetail = (entry: GridEntry, day: RangeDayData) => {
    const resolved =
      entry.subjectKind === "event"
        ? (provisionalTemplateOf(entry.record, bootstrap) ??
          templateForKind(bootstrap, "event", stringField(entry.record, "kind") ?? "") ??
          bootstrap.kindTemplates.find((t) => t.subjectKind === "event") ??
          null)
        : (templateForKind(bootstrap, "absence", stringField(entry.record, "kind") ?? "") ??
          bootstrap.kindTemplates.find((t) => t.subjectKind === "absence") ??
          null);
    if (!resolved) return;
    const dayScheduleId =
      typeof day.day["dayScheduleId"] === "string" ? (day.day["dayScheduleId"] as string) : null;
    setDetail({
      subjectKind: entry.subjectKind,
      template: resolved,
      record: entry.record,
      date: day.date,
      dayScheduleId,
    });
  };

  const detailDay = detailDate ? (byDate.get(detailDate) ?? null) : null;

  return (
    <div className="calendar-grid-wrap">
      <div className="calendar-grid">
        <div className="grid-week-head">
          {(weeks[0] ?? []).map((date) => {
            const weekday = date ? weekdayLabel(date) : "";
            return (
              <div
                key={date}
                className={`grid-weekday${weekday === "土" ? " kind-sat" : weekday === "日" ? " kind-holiday" : ""}`}
              >
                {weekday}
              </div>
            );
          })}
        </div>
        {weeks.map((week) => {
          const weekStart = week[0] as string;
          const weekEnd = week[week.length - 1] as string;
          const weekBars = entries.filter(
            (e) => e.multi && e.start <= weekEnd && e.end >= weekStart,
          );
          const { laneOf, laneCount } = barLanes(
            weekBars.map((e) => ({
              id: stringField(e.record, "id") ?? `${e.start}|${e.text}`,
              start: e.start,
              end: e.end,
            })),
            weekStart,
          );
          const lanes: GridEntry[][] = Array.from({ length: laneCount }, () => []);
          for (const bar of weekBars) {
            const id = stringField(bar.record, "id") ?? `${bar.start}|${bar.text}`;
            const lane = laneOf.get(id);
            if (lane !== undefined) lanes[lane]?.push(bar);
          }
          return (
            <div key={weekStart} className="grid-week">
              {lanes.map((laneBars, laneIndex) => (
                <div key={laneIndex} className="grid-bar-lane">
                  {laneBars.map((bar) => {
                    const startCol = week.indexOf(bar.start < weekStart ? weekStart : bar.start);
                    const endCol = week.indexOf(bar.end > weekEnd ? weekEnd : bar.end);
                    const day = byDate.get(bar.start < weekStart ? weekStart : bar.start);
                    const classes = [
                      "grid-bar",
                      bar.start >= weekStart ? "bar-start" : "",
                      bar.end <= weekEnd ? "bar-end" : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const style = {
                      gridColumn: `${startCol + 1} / ${endCol + 2}`,
                    };
                    return canOpen(bar) && day ? (
                      <button
                        key={stringField(bar.record, "id") ?? bar.text}
                        type="button"
                        className={classes}
                        style={style}
                        data-start={bar.start}
                        data-end={bar.end}
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetail(bar, day);
                        }}
                      >
                        {bar.text}
                      </button>
                    ) : (
                      <span
                        key={stringField(bar.record, "id") ?? bar.text}
                        className={classes}
                        style={style}
                        data-start={bar.start}
                        data-end={bar.end}
                      >
                        {bar.text}
                      </span>
                    );
                  })}
                </div>
              ))}
              <div className="grid-cells">
                {week.map((date) => {
                  const day = byDate.get(date);
                  if (!day) return <div key={date} className="grid-cell empty" data-date={date} />;
                  const mark = dayMark(day, bootstrap.masters.dayPatterns);
                  const lines = dayLines(day, bootstrap);
                  const shown = lines.slice(0, MAX_CELL_ENTRIES);
                  const hidden = lines.length - shown.length;
                  const holidayNames = day.holidays
                    .map((h) => (typeof h["name"] === "string" ? (h["name"] as string) : null))
                    .filter((n): n is string => n !== null);
                  const dailyLines = compactDailyLinesFor(day, bootstrap, range);
                  return (
                    <div
                      key={date}
                      className={`grid-cell kind-${mark.kind || "plain"}${mark.closed ? " closed" : ""}${date.slice(0, 7) !== month ? " outside" : ""}`}
                      data-date={date}
                      onClick={() => setDetailDate(date)}
                    >
                      <div className="grid-cell-head">
                        <span className="grid-date-num">{Number(date.slice(8, 10))}</span>
                        {holidayNames.map((name) => (
                          <span key={name} className="grid-holiday">
                            {name}
                          </span>
                        ))}
                      </div>
                      {shown.map((line) =>
                        canOpen(line) ? (
                          <button
                            key={stringField(line.record, "id") ?? line.text}
                            type="button"
                            className="grid-entry"
                            onClick={(e) => {
                              e.stopPropagation();
                              openDetail(line, day);
                            }}
                          >
                            {line.text}
                          </button>
                        ) : (
                          <span
                            key={stringField(line.record, "id") ?? line.text}
                            className="grid-entry"
                          >
                            {line.text}
                          </span>
                        ),
                      )}
                      {hidden > 0 && <div className="grid-more">他{hidden}件</div>}
                      {dailyLines.map((line) => (
                        <div key={line.columnId} className="grid-daily">
                          {line.text}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {detailDay && (
        <DayDetail
          bootstrap={bootstrap}
          range={range}
          day={detailDay}
          editor={editor}
          onClose={() => setDetailDate(null)}
        />
      )}
      {detail && editor && (
        <DetailModal
          target={detail}
          bootstrap={bootstrap}
          api={editor.api}
          onSaved={editor.onSaved}
          onUnauthorizedError={editor.onUnauthorizedError}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

/** The compact daily lines of one cell, from the view's own
 *  columns: the symbol / boolean daily items — the kinds that
 *  read at a glance — with a value that day, as 「項目名：値」.
 *  The prototype's grid drew the same line; the rest of the
 *  day's values read in the day detail, which draws every
 *  column. */
function compactDailyLinesFor(
  day: RangeDayData,
  bootstrap: BootstrapData,
  range: RangeData,
): { columnId: string; text: string }[] {
  const out: { columnId: string; text: string }[] = [];
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  for (const column of columns) {
    if (column.sourceKind !== "daily_item") continue;
    const item = bootstrap.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
    if (!item || (item.valueType !== "symbol" && item.valueType !== "boolean")) continue;
    const text = dailyCellText(day, column, bootstrap);
    if (text) out.push({ columnId: column.id, text: `${item.name}：${text}` });
  }
  return out;
}
