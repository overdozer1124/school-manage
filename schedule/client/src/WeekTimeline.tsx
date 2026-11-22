import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { UnauthorizedError } from "./api";
import { buildEventRecord, type CellEditorContext } from "./cells";
import { DetailModal, type DetailTarget } from "./DetailModal";
import { QuickPopover, type QuickPopoverTarget } from "./QuickPopover";
import {
  absenceLineText,
  dayLabel,
  dayMark,
  dayPeriodBands,
  entryClockSpan,
  entryPeriod,
  eventTimeText,
  eventTitle,
  minutesToTimeText,
  provisionalLineText,
  provisionalTemplateOf,
  templateForKind,
  timeLanes,
  timelineConfig,
  weekPeriodRows,
  type DayPeriodBand,
} from "./lib";
import type { BootstrapData, RangeData, RangeDayData } from "./types";

/**
 * The L5 week timeline (week_timeline, Issue #44; DESIGN
 * schedule 4.8.1): one day's timeline laid out seven times side
 * by side — columns are the week's days, the vertical axis is
 * time. The range is the anchor's week (lib's timelineRange),
 * and the axis follows the view's layout_params (lib's
 * timelineConfig): its clock range and step, or the period axis
 * （時限軸モード）, whose rows are the lesson periods of each
 * day's own day pattern — 朝・1〜N限・放課後 — so an entry is
 * placed by the pattern in force on its own day.
 *
 * An entry with a clock placement stands as a block at its
 * start, for its length; blocks that overlap in time are laid
 * side by side in lanes (lib's timeLanes). All-day entries and
 * entries with no time stand in the band above their column
 * （終日帯）. A spanning entry stands in every day of its span,
 * as the range bundle places it there.
 *
 * Input (DESIGN schedule 4.8.1, L5): selecting a time slot — a
 * click, or Enter / Space on the focused slot — starts input
 * with that slot as the draft's start and end: the title is
 * typed into the slot form, Enter creates the entry carrying
 * the slot's time, and from there the flow is the other
 * layouts' — the quick-entry popover, or the detail modal in a
 * school whose default is the modal (6.5), with the slot's time
 * already settled in it. A period-axis slot seeds a periods
 * time (the morning and after-school bands, which a periods
 * time cannot name, seed their band's clock times instead).
 * The all-day band takes input the way L1's entry column does:
 * a title typed there becomes an entry with no time. Clicking
 * an entry opens its detail modal, as in every layout.
 *
 * Without an editor (the public screen) the timeline is
 * read-only: no slots, no band input. The public bundle carries
 * no day patterns, so a public period-axis view falls back to
 * the clock axis rather than drawing rows it cannot place
 * entries against.
 */

const PX_PER_MINUTE = 0.8;
const MIN_BLOCK_HEIGHT = 18;

interface TlEntry {
  subjectKind: "event" | "absence";
  record: Record<string, unknown>;
  id: string;
  /** The line as the rows tables read it (time prefix included). */
  text: string;
  /** The entry's own name, without the time prefix — a timed
   *  block composes its label from its span and this. */
  plainText: string;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function revisionOf(record: Record<string, unknown>): number | null {
  const value = record["revision"];
  return typeof value === "number" ? value : null;
}

/** One day's entries, in the rows table's order — the day's
 *  events as the bundle lists them, then its absences. */
function dayEntries(day: RangeDayData, bootstrap: BootstrapData): TlEntry[] {
  const entries: TlEntry[] = [];
  for (const event of day.events) {
    const plain = provisionalTemplateOf(event, bootstrap)
      ? provisionalLineText(event)
      : eventTitle(event);
    entries.push({
      subjectKind: "event",
      record: event,
      id: stringField(event, "id") ?? `event|${day.date}|${plain}`,
      text: `${eventTimeText(event)}${plain}`,
      plainText: plain,
    });
  }
  for (const absence of day.absences) {
    const plain = absenceLineText(absence, bootstrap);
    entries.push({
      subjectKind: "absence",
      record: absence,
      id: stringField(absence, "id") ?? `absence|${day.date}|${plain}`,
      text: plain,
      plainText: plain,
    });
  }
  return entries;
}

interface SlotSelection {
  date: string;
  /** How the slot reads in the form: "11月16日（月） 09:00〜09:30"
   *  or "11月17日（火） 2限（09:50〜10:40）". */
  label: string;
  /** The CalendarTime the created entry carries. */
  time: Record<string, unknown>;
}

export function WeekTimeline({
  bootstrap,
  range,
  editor,
}: {
  bootstrap: BootstrapData;
  range: RangeData;
  editor?: CellEditorContext;
}) {
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [popover, setPopover] = useState<QuickPopoverTarget | null>(null);
  const [slot, setSlot] = useState<SlotSelection | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const config = useMemo(() => timelineConfig(range.view), [range.view]);
  const periodRows = useMemo(() => weekPeriodRows(bootstrap, range.days), [bootstrap, range.days]);
  const axis = config.axis === "period" && periodRows.length > 0 ? "period" : "time";
  const byDate = useMemo(() => new Map(range.days.map((day) => [day.date, day])), [range]);
  const isViewer = bootstrap.role === "Viewer";

  const eventTemplate = useMemo(
    () =>
      templateForKind(bootstrap, "event", "event") ??
      bootstrap.kindTemplates.find((t) => t.subjectKind === "event") ??
      null,
    [bootstrap],
  );

  const dayScheduleIdOf = (date: string): string | null => {
    const value = byDate.get(date)?.day["dayScheduleId"];
    return typeof value === "string" ? value : null;
  };

  /** Whether an entry may open its detail modal, under the same
   *  rule as the calendar grid and the entry cells: a settled
   *  record the caller may change. */
  const canOpen = (entry: TlEntry): boolean => {
    if (!editor) return false;
    if (revisionOf(entry.record) === null) return false;
    if (isViewer) {
      return entry.subjectKind === "absence" && entry.record["staffId"] === bootstrap.teacherId;
    }
    return entry.subjectKind === "event" || "purpose" in entry.record;
  };

  const openDetail = (entry: TlEntry, day: RangeDayData) => {
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
    setDetail({
      subjectKind: entry.subjectKind,
      template: resolved,
      record: entry.record,
      date: day.date,
      dayScheduleId: dayScheduleIdOf(day.date),
    });
  };

  /** Creates one event carrying the given time (a slot's, or
   *  null from the all-day band), then follows the school's
   *  input flow: the popover on the new entry, or the detail
   *  modal. True when the entry stands. */
  const createEntry = async (
    date: string,
    time: Record<string, unknown> | null,
    title: string,
  ): Promise<boolean> => {
    if (!editor || !eventTemplate || busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      const result = await editor.api.createEvent({
        event: { ...buildEventRecord(title, eventTemplate, date), time },
      });
      editor.onSaved();
      if (bootstrap.inputOpener === "popover") {
        setPopover({ subjectKind: "event", template: eventTemplate, record: result.record });
      } else {
        setDetail({
          subjectKind: "event",
          template: eventTemplate,
          record: result.record,
          date,
          dayScheduleId: dayScheduleIdOf(date),
        });
      }
      return true;
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        editor.onUnauthorizedError();
      } else {
        setNotice(
          cause instanceof Error && cause.message
            ? `保存できませんでした：${cause.message}`
            : "保存できませんでした",
        );
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openSlot = (selection: SlotSelection) => {
    setSlot(selection);
    setDraftTitle("");
    setNotice(null);
    setPopover(null);
  };

  const submitSlot = async () => {
    const title = draftTitle.trim();
    if (!slot || !title) return;
    if (await createEntry(slot.date, slot.time, title)) {
      setSlot(null);
      setDraftTitle("");
    }
  };

  /** The all-day band's entries of one day, under this axis:
   *  what has no placement on the axis stands in the band. */
  const bandEntriesOf = (day: RangeDayData, bands: DayPeriodBand[]): TlEntry[] =>
    dayEntries(day, bootstrap).filter((entry) => {
      if (axis === "period") return entryPeriod(entry.record, bands) === null;
      const span = entryClockSpan(entry.record, bands);
      // No clock placement, or a span lying wholly outside the
      // axis's range: the entry stands in the band, with its
      // time in its line, rather than vanishing off the axis.
      return span === null || span.end <= config.startMinutes || span.start >= config.endMinutes;
    });

  const renderEntryLine = (entry: TlEntry, day: RangeDayData, className: string) =>
    canOpen(entry) ? (
      <button
        key={entry.id}
        type="button"
        className={className}
        onClick={(e) => {
          e.stopPropagation();
          openDetail(entry, day);
        }}
      >
        {entry.text}
      </button>
    ) : (
      <span key={entry.id} className={className}>
        {entry.text}
      </span>
    );

  const axisHeight = (config.endMinutes - config.startMinutes) * PX_PER_MINUTE;
  const hourMarks: number[] = [];
  for (let m = Math.ceil(config.startMinutes / 60) * 60; m < config.endMinutes; m += 60) {
    hourMarks.push(m);
  }
  const slots: number[] = [];
  for (
    let m = config.startMinutes;
    m + config.intervalMinutes <= config.endMinutes;
    m += config.intervalMinutes
  ) {
    slots.push(m);
  }

  return (
    <div className="timeline-wrap">
      {slot && editor && (
        <form
          className="timeline-slot-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitSlot();
          }}
        >
          <label className="timeline-slot-label">
            {slot.label} の予定を追加{" "}
            <input
              aria-label={`${slot.label}の予定の件名`}
              value={draftTitle}
              disabled={busy}
              autoFocus
              onChange={(e) => setDraftTitle(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || draftTitle.trim() === ""}>
            追加
          </button>
          <button type="button" onClick={() => setSlot(null)}>
            やめる
          </button>
          {notice && (
            <p className="cell-notice" role="alert">
              {notice}
            </p>
          )}
        </form>
      )}
      {popover && editor && (
        <div className="entry-cell timeline-popover-anchor">
          <QuickPopover
            target={popover}
            bootstrap={bootstrap}
            api={editor.api}
            onSaved={editor.onSaved}
            onUnauthorizedError={editor.onUnauthorizedError}
            onClose={() => setPopover(null)}
            onOpenDetail={(record) => {
              const date = stringField(record, "startsOn") ?? "";
              setDetail({
                subjectKind: popover.subjectKind,
                template: popover.template,
                record,
                date,
                dayScheduleId: dayScheduleIdOf(date),
              });
              setPopover(null);
            }}
          />
        </div>
      )}

      <div className="timeline-grid" style={{ gridTemplateColumns: `44px repeat(7, 1fr)` }}>
        <div className="timeline-corner" />
        {range.days.map((day) => {
          const mark = dayMark(day, bootstrap.masters.dayPatterns);
          const holidayNames = day.holidays
            .map((h) => (typeof h["name"] === "string" ? (h["name"] as string) : null))
            .filter((n): n is string => n !== null);
          return (
            <div
              key={day.date}
              className={`timeline-day-head kind-${mark.kind || "plain"}${mark.closed ? " closed" : ""}`}
            >
              <span className="timeline-day-label">{dayLabel(day.date)}</span>
              {holidayNames.map((name) => (
                <span key={name} className="grid-holiday">
                  {name}
                </span>
              ))}
            </div>
          );
        })}

        <div className="timeline-corner timeline-band-corner">終日</div>
        {range.days.map((day) => {
          const bands = dayPeriodBands(bootstrap, day);
          return (
            <div key={`band-${day.date}`} className="timeline-band-cell" data-date={day.date}>
              {bandEntriesOf(day, bands).map((entry) =>
                renderEntryLine(entry, day, "timeline-band-entry"),
              )}
              {editor && eventTemplate && (
                <BandInput
                  label={dayLabel(day.date)}
                  busy={busy}
                  notice={notice}
                  onCreate={(title) => createEntry(day.date, null, title)}
                />
              )}
            </div>
          );
        })}
      </div>

      {axis === "time" ? (
        <div
          className="timeline-grid timeline-body"
          style={{ gridTemplateColumns: `44px repeat(7, 1fr)` }}
        >
          <div className="timeline-gutter" style={{ height: axisHeight }}>
            {hourMarks.map((m) => (
              <span
                key={m}
                className="timeline-hour"
                style={{ top: (m - config.startMinutes) * PX_PER_MINUTE }}
              >
                {minutesToTimeText(m)}
              </span>
            ))}
          </div>
          {range.days.map((day) => {
            const bands = dayPeriodBands(bootstrap, day);
            const timed = dayEntries(day, bootstrap)
              .map((entry) => ({ entry, span: entryClockSpan(entry.record, bands) }))
              .filter(
                (
                  x,
                ): x is {
                  entry: TlEntry;
                  span: { start: number; end: number };
                } =>
                  x.span !== null &&
                  x.span.end > config.startMinutes &&
                  x.span.start < config.endMinutes,
              );
            const { laneOf, laneCount } = timeLanes(
              timed.map(({ entry, span }) => ({ id: entry.id, start: span.start, end: span.end })),
            );
            const mark = dayMark(day, bootstrap.masters.dayPatterns);
            return (
              <div
                key={day.date}
                className={`timeline-day-column${mark.closed ? " closed" : ""}`}
                data-date={day.date}
                style={{
                  height: axisHeight,
                  backgroundSize: `100% ${config.intervalMinutes * PX_PER_MINUTE}px`,
                }}
              >
                {editor &&
                  slots.map((start) => {
                    const end = start + config.intervalMinutes;
                    const label = `${dayLabel(day.date)} ${minutesToTimeText(start)}〜${minutesToTimeText(end)}`;
                    return (
                      <button
                        key={start}
                        type="button"
                        className="timeline-slot"
                        data-date={day.date}
                        data-start={minutesToTimeText(start)}
                        data-end={minutesToTimeText(end)}
                        aria-label={`${label}に予定を追加`}
                        style={{
                          top: (start - config.startMinutes) * PX_PER_MINUTE,
                          height: config.intervalMinutes * PX_PER_MINUTE,
                        }}
                        onClick={() =>
                          openSlot({
                            date: day.date,
                            label,
                            time: {
                              kind: "clock",
                              startsAt: minutesToTimeText(start),
                              endsAt: minutesToTimeText(end),
                            },
                          })
                        }
                      />
                    );
                  })}
                {timed.map(({ entry, span }) => {
                  const lane = laneOf.get(entry.id) ?? 0;
                  const clampedStart = Math.max(span.start, config.startMinutes);
                  const clampedEnd = Math.min(span.end, config.endMinutes);
                  const style = {
                    top: (clampedStart - config.startMinutes) * PX_PER_MINUTE,
                    height: Math.max(
                      MIN_BLOCK_HEIGHT,
                      (clampedEnd - clampedStart) * PX_PER_MINUTE - 2,
                    ),
                    left: `calc(${(lane * 100) / laneCount}% + 1px)`,
                    width: `calc(${100 / laneCount}% - 2px)`,
                  };
                  const label = `${minutesToTimeText(span.start)}〜${minutesToTimeText(span.end)} ${entry.plainText}`;
                  return canOpen(entry) ? (
                    <button
                      key={entry.id}
                      type="button"
                      className="timeline-block"
                      style={style}
                      data-start={minutesToTimeText(span.start)}
                      data-end={minutesToTimeText(span.end)}
                      data-lane={lane}
                      onClick={(e) => {
                        e.stopPropagation();
                        openDetail(entry, day);
                      }}
                    >
                      {label}
                    </button>
                  ) : (
                    <span
                      key={entry.id}
                      className="timeline-block"
                      style={style}
                      data-start={minutesToTimeText(span.start)}
                      data-end={minutesToTimeText(span.end)}
                      data-lane={lane}
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="timeline-period-body">
          {periodRows.map((row) => (
            <div
              key={row.period}
              className="timeline-grid timeline-period-row"
              style={{ gridTemplateColumns: `44px repeat(7, 1fr)` }}
            >
              <div className="timeline-period-label">
                <span className="timeline-period-name">{row.label}</span>
                {row.startsAt && row.endsAt && (
                  <span className="timeline-period-time">
                    {row.startsAt}〜{row.endsAt}
                  </span>
                )}
              </div>
              {range.days.map((day) => {
                const bands = dayPeriodBands(bootstrap, day);
                const dayBand = bands.find((b) => b.period === row.period) ?? row;
                const placed = dayEntries(day, bootstrap).filter(
                  (entry) => entryPeriod(entry.record, bands) === row.period,
                );
                const selection: SlotSelection = {
                  date: day.date,
                  label: `${dayLabel(day.date)} ${dayBand.label}${
                    dayBand.startsAt && dayBand.endsAt
                      ? `（${dayBand.startsAt}〜${dayBand.endsAt}）`
                      : ""
                  }`,
                  time:
                    row.period >= 1 && row.period <= 90
                      ? { kind: "periods", from: row.period, to: row.period }
                      : dayBand.startsAt && dayBand.endsAt
                        ? { kind: "clock", startsAt: dayBand.startsAt, endsAt: dayBand.endsAt }
                        : { kind: "all_day" },
                };
                return (
                  <div
                    key={day.date}
                    className="timeline-period-cell"
                    data-date={day.date}
                    data-period={row.period}
                    {...(editor
                      ? {
                          role: "button" as const,
                          tabIndex: 0,
                          "aria-label": `${selection.label}に予定を追加`,
                          onClick: () => openSlot(selection),
                          onKeyDown: (e: ReactKeyboardEvent) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openSlot(selection);
                            }
                          },
                        }
                      : {})}
                  >
                    {placed.map((entry) => renderEntryLine(entry, day, "timeline-chip"))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <p className="timeline-hint">
        {axis === "period"
          ? "時限のマスを選ぶと、その時限が初期値になった状態で入力が始まります。"
          : "空いている時間帯を選ぶと、その時間が初期値になった状態で入力が始まります。"}
      </p>

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

/** The all-day band's input: a title typed here becomes an
 *  entry with no time, the way L1's entry column takes one
 *  (DESIGN schedule 4.8.1: 時刻のない予定は終日帯で L1 と同様に
 *  入力できる). */
function BandInput({
  label,
  busy,
  notice,
  onCreate,
}: {
  /** The day as it reads on screen ("11/16（月）"). */
  label: string;
  busy: boolean;
  notice: string | null;
  onCreate(title: string): Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  return (
    <span className="timeline-band-input">
      <input
        aria-label={`${label}の終日予定を追加`}
        value={draft}
        disabled={busy}
        onChange={(e) => {
          setDraft(e.target.value);
          setFailed(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const title = draft.trim();
            if (!title) return;
            void onCreate(title).then((ok) => {
              if (ok) setDraft("");
              else setFailed(true);
            });
          }
        }}
      />
      {failed && notice && (
        <span className="cell-notice" role="alert">
          {notice}
        </span>
      )}
    </span>
  );
}
