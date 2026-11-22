import "@testing-library/jest-dom/vitest";
import { datesInRange } from "@school-manage/calendar-types";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { PublicApi, ScheduleApi } from "../src/api";
import type { CellEditorContext } from "../src/cells";
import { createDevApi } from "../src/devAdapter";
import {
  dayPeriodBands,
  entryClockSpan,
  entryPeriod,
  rangeFor,
  stepAnchor,
  timeLanes,
  timelineConfig,
  weekPeriodRows,
} from "../src/lib";
import { PublicApp } from "../src/PublicApp";
import { WeekTimeline } from "../src/WeekTimeline";
import type {
  BootstrapData,
  PublicBootstrapData,
  RangeData,
  RangeDayData,
  ViewColumnData,
  ViewDefinitionData,
} from "../src/types";

afterEach(cleanup);

// Week timeline tests (Issue #44): the L5 week_timeline view —
// seven day columns against a time axis (or the period axis of
// each day's own day pattern), overlapping entries laid side by
// side in lanes, all-day entries in the band above each column,
// and input that starts from a selected slot with that slot as
// the draft's initial time (DESIGN schedule 4.8.1). The week of
// the fixtures is November 16–22, 2026 (Monday to Sunday).

const STAFF = [
  { id: "staff-1", name: "田中一郎" },
  { id: "staff-2", name: "佐藤花" },
];
const GRADES = [
  { id: "grade-1", name: "1年" },
  { id: "grade-2", name: "2年" },
];

/** Pattern A: the school's standard day — the morning band,
 *  six lesson periods, the after-school band. */
const PATTERN_A = {
  id: "pattern-a",
  code: "A",
  name: "A日課",
  periods: [
    { period: 0, label: "朝", startsAt: "07:30", endsAt: "08:30" },
    { period: 1, label: "1限", startsAt: "08:50", endsAt: "09:40" },
    { period: 2, label: "2限", startsAt: "09:50", endsAt: "10:40" },
    { period: 3, label: "3限", startsAt: "10:50", endsAt: "11:40" },
    { period: 4, label: "4限", startsAt: "11:50", endsAt: "12:40" },
    { period: 5, label: "5限", startsAt: "13:30", endsAt: "14:20" },
    { period: 6, label: "6限", startsAt: "14:30", endsAt: "15:20" },
    { period: 99, label: "放課後", startsAt: "15:30", endsAt: "18:00" },
  ],
};

/** Pattern B: a shortened day — its 2限 runs 09:40–10:20, where
 *  pattern A has a break, so the same clock time lands in a
 *  different row under B than under A. */
const PATTERN_B = {
  id: "pattern-b",
  code: "B",
  name: "B日課",
  periods: [
    { period: 1, label: "1限", startsAt: "08:50", endsAt: "09:30" },
    { period: 2, label: "2限", startsAt: "09:40", endsAt: "10:20" },
    { period: 3, label: "3限", startsAt: "10:30", endsAt: "11:10" },
    { period: 4, label: "4限", startsAt: "11:20", endsAt: "12:00" },
  ],
};

function column(
  id: string,
  sourceKind: ViewColumnData["sourceKind"],
  sort: number,
  extra: Partial<ViewColumnData> = {},
): ViewColumnData {
  return {
    id,
    viewDefinitionId: "view-timeline",
    sourceKind,
    itemDefinitionId: null,
    dutyDefinitionId: null,
    targetGroupId: null,
    groupSameValues: true,
    widthHint: null,
    sort,
    ...extra,
  };
}

const timelineView: ViewDefinitionData = {
  id: "view-timeline",
  name: "職員用タイムライン",
  layout: "week_timeline",
  layoutParams: null,
  audience: "staff",
  periodScope: "week",
  printSettings: null,
  isArchived: false,
  columns: [
    column("col-events", "event_category", 1),
    column("col-lunch", "daily_item", 2, { itemDefinitionId: "item-lunch" }),
  ],
};

const periodView: ViewDefinitionData = {
  ...timelineView,
  id: "view-timeline-period",
  name: "職員用タイムライン（時限）",
  layoutParams: { axis: "period" },
};

function makeBootstrap(views: ViewDefinitionData[] = [timelineView]): BootstrapData {
  return {
    school: { id: "school-1", name: "テスト学校" },
    userId: "user-1",
    teacherId: "staff-1",
    role: "Editor",
    permissions: ["view.read", "daily.write", "event.write"],
    views,
    itemDefinitions: [
      {
        id: "item-lunch",
        key: "lunch",
        name: "給食",
        valueType: "symbol",
        targetGroupId: null,
        targetPlatformAxis: null,
        granularity: "day",
        defaultVisibility: "staff_only",
        sort: 1,
        options: [
          { id: "opt-lunch-yes", code: "yes", label: "○", sort: 1 },
          { id: "opt-lunch-no", code: "no", label: "×", sort: 2 },
        ],
      },
    ],
    targetGroups: [],
    kindTemplates: [
      {
        id: "tpl-event",
        key: "event",
        name: "行事",
        subjectKind: "event",
        kindCode: "event",
        personLabel: "担当者",
        displaySource: "title",
        steps: [{ kind: "person" }, { kind: "time" }],
        itemDefinitionIds: [],
        sort: 1,
      },
      {
        id: "tpl-leave",
        key: "leave",
        name: "休暇",
        subjectKind: "absence",
        kindCode: "leave",
        personLabel: "取得者",
        displaySource: "person",
        steps: [{ kind: "person" }],
        itemDefinitionIds: [],
        sort: 2,
      },
    ],
    dutyDefinitions: [],
    locations: [],
    absenceSubdivisions: [
      { id: "subdiv-annual", code: "leave", key: "annual", label: "年休", sort: 10, revision: 1 },
    ],
    inputOpener: "popover",
    masters: { staff: STAFF, grades: GRADES, dayPatterns: [PATTERN_A, PATTERN_B] },
  };
}

function eventOn(
  id: string,
  date: string,
  title: string,
  time: unknown = null,
): Record<string, unknown> {
  return {
    id,
    kind: "event",
    kindLabel: null,
    title,
    datePrecision: "day",
    startsOn: date,
    endsOn: date,
    time,
    certainty: "confirmed",
    assignees: [],
    revision: 1,
  };
}

function absenceOn(
  id: string,
  date: string,
  time: unknown = { kind: "all_day" },
): Record<string, unknown> {
  return {
    id,
    kind: "leave",
    staffId: "staff-2",
    fromDate: date,
    toDate: date,
    time,
    purpose: null,
    note: null,
    subdivisionKey: "annual",
    revision: 1,
  };
}

interface RangeFixture {
  events?: Record<string, unknown>[];
  absences?: Record<string, unknown>[];
  /** Per-date day pattern overrides (default pattern-a). */
  scheduleIds?: Record<string, string>;
}

/** The week bundle for a view, as getRange returns it: one day
 *  per date of rangeFor, a spanning entry in every day of its
 *  span. */
function makeRange(
  view: ViewDefinitionData,
  fixture: RangeFixture = {},
  anchor = "2026-11-16",
): RangeData {
  const { from, to } = rangeFor(view, anchor);
  const inSpan = (date: string, start: string, end: string) => date >= start && date <= end;
  const days: RangeDayData[] = datesInRange(from, to).map((date) => ({
    date,
    day: {
      date,
      dayType: "class_day",
      dayTypeLabel: null,
      dayScheduleId: fixture.scheduleIds?.[date] ?? "pattern-a",
      weekdaySwap: null,
      note: null,
      source: "default",
    },
    holidays: [],
    events: (fixture.events ?? []).filter((e) =>
      inSpan(date, e["startsOn"] as string, e["endsOn"] as string),
    ),
    absences: (fixture.absences ?? []).filter((a) =>
      inSpan(date, a["fromDate"] as string, a["toDate"] as string),
    ),
    dailyValues: [],
    dutyAssignments: [],
  }));
  return { view, from, to, days, undecided: [], eventValues: [], conflicts: [] };
}

function bandCell(date: string): HTMLElement {
  const el = document.querySelector(`.timeline-band-cell[data-date="${date}"]`);
  if (!el) throw new Error(`no band cell for ${date}`);
  return el as HTMLElement;
}

function periodCell(date: string, period: number): HTMLElement {
  const el = document.querySelector(
    `.timeline-period-cell[data-date="${date}"][data-period="${period}"]`,
  );
  if (!el) throw new Error(`no period cell for ${date} period ${period}`);
  return el as HTMLElement;
}

function block(text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>(".timeline-block")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!el) throw new Error(`no timeline block for ${text}`);
  return el;
}

describe("lib: the timeline view's week and axis settings", () => {
  it("reads the anchor's Monday-start week and steps by weeks", () => {
    expect(rangeFor(timelineView, "2026-11-18")).toEqual({
      from: "2026-11-16",
      to: "2026-11-22",
    });
    expect(stepAnchor(timelineView, "2026-11-16", 1)).toBe("2026-11-23");
    expect(stepAnchor(timelineView, "2026-11-16", -1)).toBe("2026-11-09");
    // The week start follows the view's setting, as in L4.
    const sundayView: ViewDefinitionData = {
      ...timelineView,
      layoutParams: { weekStart: "sun" },
    };
    expect(rangeFor(sundayView, "2026-11-18")).toEqual({
      from: "2026-11-15",
      to: "2026-11-21",
    });
  });

  it("reads the axis settings from layout_params, with the prototype's defaults", () => {
    expect(timelineConfig(timelineView)).toEqual({
      axis: "time",
      startMinutes: 7 * 60,
      endMinutes: 19 * 60,
      intervalMinutes: 30,
    });
    expect(timelineConfig(periodView).axis).toBe("period");
    expect(
      timelineConfig({
        ...timelineView,
        layoutParams: { startTime: "08:00", endTime: "17:00", intervalMinutes: 60 },
      }),
    ).toEqual({ axis: "time", startMinutes: 8 * 60, endMinutes: 17 * 60, intervalMinutes: 60 });
    // An end at or before the start falls back to the defaults.
    expect(
      timelineConfig({ ...timelineView, layoutParams: { startTime: "18:00", endTime: "09:00" } }),
    ).toMatchObject({ startMinutes: 7 * 60, endMinutes: 19 * 60 });
  });

  it("lays overlapping blocks side by side and sequences in one lane", () => {
    const { laneOf, laneCount } = timeLanes([
      { id: "a", start: 540, end: 630 },
      { id: "b", start: 600, end: 660 },
      { id: "c", start: 660, end: 720 },
    ]);
    expect(laneCount).toBe(2);
    expect(laneOf.get("a")).toBe(0);
    expect(laneOf.get("b")).toBe(1);
    // c starts after a has ended: it takes the first free lane.
    expect(laneOf.get("c")).toBe(0);
    expect(timeLanes([{ id: "x", start: 0, end: 60 }]).laneCount).toBe(1);
  });
});

describe("lib: placement against the day's own pattern", () => {
  const bootstrap = makeBootstrap();
  const dayA = makeRange(timelineView).days[0] as RangeDayData;
  const bandsA = dayPeriodBands(bootstrap, dayA);

  it("reads a day's bands with the morning and after-school bands", () => {
    expect(bandsA.map((b) => b.period)).toEqual([0, 1, 2, 3, 4, 5, 6, 99]);
    expect(bandsA[0]).toMatchObject({ label: "朝", startsAt: "07:30", endsAt: "08:30" });
    expect(bandsA[bandsA.length - 1]).toMatchObject({ label: "放課後" });
    const rows = weekPeriodRows(bootstrap, makeRange(timelineView).days);
    expect(rows.map((r) => r.period)).toEqual([0, 1, 2, 3, 4, 5, 6, 99]);
  });

  it("places clock entries by the periods they overlap", () => {
    const at = (startsAt: string, endsAt: string) =>
      eventOn("e", "2026-11-16", "x", { kind: "clock", startsAt, endsAt });
    expect(entryPeriod(at("09:00", "09:30"), bandsA)).toBe(1);
    expect(entryPeriod(at("08:00", "08:20"), bandsA)).toBe(0);
    expect(entryPeriod(at("16:00", "17:00"), bandsA)).toBe(99);
    // In the break between 1限 and 2限, under pattern A the
    // entry overlaps no period at all.
    expect(entryPeriod(at("09:45", "09:48"), bandsA)).toBeNull();
    expect(entryPeriod(eventOn("e", "2026-11-16", "x", { kind: "all_day" }), bandsA)).toBeNull();
    expect(
      entryPeriod(eventOn("e", "2026-11-16", "x", { kind: "periods", from: 2, to: 3 }), bandsA),
    ).toBe(2);
  });

  it("places the same clock time by the day's own pattern, not another day's", () => {
    const range = makeRange(timelineView, { scheduleIds: { "2026-11-18": "pattern-b" } });
    const dayB = range.days.find((d) => d.date === "2026-11-18") as RangeDayData;
    const bandsB = dayPeriodBands(bootstrap, dayB);
    // 09:45–09:48 sits in pattern B's 2限 (09:40–10:20).
    const entry = eventOn("e", "2026-11-18", "x", {
      kind: "clock",
      startsAt: "09:45",
      endsAt: "09:48",
    });
    expect(entryPeriod(entry, bandsB)).toBe(2);
    expect(entryPeriod(entry, bandsA)).toBeNull();
  });

  it("derives a periods entry's clock span from the day's pattern", () => {
    const entry = eventOn("e", "2026-11-16", "x", { kind: "periods", from: 2, to: 3 });
    expect(entryClockSpan(entry, bandsA)).toEqual({
      start: 9 * 60 + 50,
      end: 11 * 60 + 40,
    });
    expect(entryClockSpan(eventOn("e", "2026-11-16", "x", null), bandsA)).toBeNull();
    expect(
      entryClockSpan(
        eventOn("e", "2026-11-16", "x", { kind: "clock", startsAt: "10:00", endsAt: null }),
        bandsA,
      ),
    ).toEqual({ start: 600, end: 660 });
  });
});

describe("WeekTimeline: the clock axis", () => {
  it("draws seven day columns, timed entries as blocks, the rest in the band", () => {
    render(
      <WeekTimeline
        bootstrap={makeBootstrap()}
        range={makeRange(timelineView, {
          events: [
            eventOn("ev-1", "2026-11-16", "研究授業", {
              kind: "clock",
              startsAt: "09:00",
              endsAt: "10:30",
            }),
            eventOn("ev-2", "2026-11-16", "遠足", { kind: "all_day" }),
            eventOn("ev-3", "2026-11-17", "職員会議"),
          ],
          absences: [
            absenceOn("ab-1", "2026-11-18", {
              kind: "clock",
              startsAt: "10:00",
              endsAt: "11:00",
            }),
          ],
        })}
      />,
    );
    expect(document.querySelectorAll(".timeline-day-column")).toHaveLength(7);
    const b = block("研究授業");
    expect(b.dataset["start"]).toBe("09:00");
    expect(b.dataset["end"]).toBe("10:30");
    expect(b).toHaveTextContent("09:00〜10:30 研究授業");
    // A timed absence is a block too, read holder-led.
    expect(block("佐藤花（年休）").dataset["start"]).toBe("10:00");
    // The all-day and untimed entries stand in their days' bands.
    expect(bandCell("2026-11-16")).toHaveTextContent("遠足");
    expect(bandCell("2026-11-17")).toHaveTextContent("職員会議");
    expect(bandCell("2026-11-16")).not.toHaveTextContent("研究授業");
  });

  it("lays overlapping entries side by side in separate lanes", () => {
    render(
      <WeekTimeline
        bootstrap={makeBootstrap()}
        range={makeRange(timelineView, {
          events: [
            eventOn("ev-1", "2026-11-16", "研究授業", {
              kind: "clock",
              startsAt: "09:00",
              endsAt: "10:30",
            }),
            eventOn("ev-2", "2026-11-16", "学年会議", {
              kind: "clock",
              startsAt: "10:00",
              endsAt: "11:00",
            }),
            eventOn("ev-3", "2026-11-16", "クラブ活動", {
              kind: "clock",
              startsAt: "13:30",
              endsAt: "14:20",
            }),
          ],
        })}
      />,
    );
    // The overlapping pair splits the column's width in two;
    // the entry that overlaps nothing takes the first lane back.
    expect(block("研究授業").dataset["lane"]).toBe("0");
    expect(block("学年会議").dataset["lane"]).toBe("1");
    expect(block("研究授業").style.width).toContain("50%");
    expect(block("学年会議").style.left).toContain("50%");
    expect(block("クラブ活動").dataset["lane"]).toBe("0");
    expect(block("クラブ活動").style.width).toContain("50%");
  });

  it("places a periods entry on the clock axis by its pattern times", () => {
    render(
      <WeekTimeline
        bootstrap={makeBootstrap()}
        range={makeRange(timelineView, {
          events: [
            eventOn("ev-1", "2026-11-17", "総合学習発表", { kind: "periods", from: 2, to: 3 }),
          ],
        })}
      />,
    );
    const b = block("総合学習発表");
    expect(b.dataset["start"]).toBe("09:50");
    expect(b.dataset["end"]).toBe("11:40");
  });

  it("keeps an entry outside the axis range visible in the band, with its time", () => {
    render(
      <WeekTimeline
        bootstrap={makeBootstrap()}
        range={makeRange(timelineView, {
          events: [
            eventOn("ev-1", "2026-11-16", "夜間会議", {
              kind: "clock",
              startsAt: "20:00",
              endsAt: "21:00",
            }),
          ],
        })}
      />,
    );
    expect(document.querySelectorAll(".timeline-block")).toHaveLength(0);
    expect(bandCell("2026-11-16")).toHaveTextContent("20:00〜21:00 夜間会議");
  });

  it("is read-only without an editor: no slots, no band input, blocks are not buttons", () => {
    render(
      <WeekTimeline
        bootstrap={makeBootstrap()}
        range={makeRange(timelineView, {
          events: [
            eventOn("ev-1", "2026-11-16", "研究授業", {
              kind: "clock",
              startsAt: "09:00",
              endsAt: "10:30",
            }),
          ],
        })}
      />,
    );
    expect(document.querySelectorAll(".timeline-slot")).toHaveLength(0);
    expect(screen.queryByLabelText(/終日予定を追加/)).not.toBeInTheDocument();
    expect(block("研究授業").tagName).toBe("SPAN");
  });
});

describe("WeekTimeline: the period axis", () => {
  it("stands one row per period of the day patterns, entries placed by their day's pattern", () => {
    render(
      <WeekTimeline
        bootstrap={makeBootstrap([periodView])}
        range={makeRange(periodView, {
          scheduleIds: { "2026-11-18": "pattern-b" },
          events: [
            eventOn("ev-1", "2026-11-16", "朝の会", {
              kind: "clock",
              startsAt: "09:00",
              endsAt: "09:30",
            }),
            eventOn("ev-2", "2026-11-17", "総合学習発表", { kind: "periods", from: 2, to: 3 }),
            // In pattern B's 2限 on the 18th; in the break under
            // pattern A on the 16th, so the same time reads in
            // the band there.
            eventOn("ev-3", "2026-11-18", "短縮日の授業", {
              kind: "clock",
              startsAt: "09:45",
              endsAt: "09:48",
            }),
            eventOn("ev-4", "2026-11-16", "休み時間の打合せ", {
              kind: "clock",
              startsAt: "09:45",
              endsAt: "09:48",
            }),
            eventOn("ev-5", "2026-11-19", "遠足", { kind: "all_day" }),
          ],
        })}
      />,
    );
    const rowLabels = [...document.querySelectorAll(".timeline-period-name")].map(
      (el) => el.textContent,
    );
    expect(rowLabels).toEqual(["朝", "1限", "2限", "3限", "4限", "5限", "6限", "放課後"]);
    expect(periodCell("2026-11-16", 1)).toHaveTextContent("朝の会");
    expect(periodCell("2026-11-17", 2)).toHaveTextContent("総合学習発表");
    expect(periodCell("2026-11-18", 2)).toHaveTextContent("短縮日の授業");
    // Under pattern A the same clock time has no period: the band.
    expect(bandCell("2026-11-16")).toHaveTextContent("休み時間の打合せ");
    expect(bandCell("2026-11-19")).toHaveTextContent("遠足");
  });
});

describe("WeekTimeline: input from a slot", () => {
  function renderWithEditor(view: ViewDefinitionData, fixture: RangeFixture = {}) {
    const createEvent = vi.fn(async (input: { event: Record<string, unknown> }) => ({
      record: { ...input.event, revision: 1 },
      values: [],
    }));
    const api = { ...createDevApi(), createEvent } as ScheduleApi;
    const onSaved = vi.fn();
    const editor: CellEditorContext = {
      api,
      onSaved,
      onUnauthorizedError: () => undefined,
    };
    render(
      <WeekTimeline
        bootstrap={makeBootstrap([view])}
        range={makeRange(view, fixture)}
        editor={editor}
      />,
    );
    return { createEvent, onSaved };
  }

  it("creates an entry carrying the selected slot as its initial time", async () => {
    const { createEvent, onSaved } = renderWithEditor(timelineView);
    const slot = screen.getByRole("button", { name: "11/16（月） 09:00〜09:30に予定を追加" });
    // The slot is a real button: keyboard focus reaches it.
    slot.focus();
    expect(slot).toHaveFocus();
    fireEvent.click(slot);
    const input = await screen.findByLabelText("11/16（月） 09:00〜09:30の予定の件名");
    fireEvent.change(input, { target: { value: "臨時集会" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0]?.[0].event).toMatchObject({
      title: "臨時集会",
      startsOn: "2026-11-16",
      endsOn: "2026-11-16",
      time: { kind: "clock", startsAt: "09:00", endsAt: "09:30" },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("creates a periods entry from a period cell, by keyboard as well as by click", async () => {
    const { createEvent } = renderWithEditor(periodView);
    const cellButton = screen.getByRole("button", {
      name: "11/17（火） 3限（10:50〜11:40）に予定を追加",
    });
    expect(cellButton).toBe(periodCell("2026-11-17", 3));
    cellButton.focus();
    expect(cellButton).toHaveFocus();
    fireEvent.keyDown(cellButton, { key: "Enter" });
    const input = await screen.findByLabelText("11/17（火） 3限（10:50〜11:40）の予定の件名");
    fireEvent.change(input, { target: { value: "理科実験" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0]?.[0].event).toMatchObject({
      title: "理科実験",
      startsOn: "2026-11-17",
      time: { kind: "periods", from: 3, to: 3 },
    });
  });

  it("seeds the morning band's clock times from a period-axis 朝 cell", async () => {
    const { createEvent } = renderWithEditor(periodView);
    fireEvent.click(
      screen.getByRole("button", { name: "11/16（月） 朝（07:30〜08:30）に予定を追加" }),
    );
    const input = await screen.findByLabelText("11/16（月） 朝（07:30〜08:30）の予定の件名");
    fireEvent.change(input, { target: { value: "朝の打合せ" } });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0]?.[0].event).toMatchObject({
      time: { kind: "clock", startsAt: "07:30", endsAt: "08:30" },
    });
  });

  it("creates an untimed entry from the all-day band, as in L1", async () => {
    const { createEvent } = renderWithEditor(timelineView);
    const input = screen.getByLabelText("11/16（月）の終日予定を追加");
    fireEvent.change(input, { target: { value: "作品展準備" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0]?.[0].event).toMatchObject({
      title: "作品展準備",
      startsOn: "2026-11-16",
      time: null,
    });
  });

  it("opens the detail modal from a timed block, as in the other layouts", async () => {
    renderWithEditor(timelineView, {
      events: [
        eventOn("ev-1", "2026-11-16", "研究授業", {
          kind: "clock",
          startsAt: "09:00",
          endsAt: "10:30",
        }),
      ],
    });
    fireEvent.click(block("研究授業"));
    const dialog = await screen.findByRole("dialog", { name: "行事の詳細" });
    expect(await within(dialog).findByDisplayValue("研究授業")).toBeInTheDocument();
  });
});

describe("the schedule screen with a timeline view", () => {
  it("reads the week, labels it by its range, and offers no publish button", async () => {
    const bootstrap = makeBootstrap();
    const rangeCalls: { from: string; to: string; viewId: string }[] = [];
    const api: ScheduleApi = {
      ...createDevApi(),
      getBootstrap: async () => bootstrap,
      getRange: async (input) => {
        rangeCalls.push(input);
        return makeRange(timelineView, {}, input.from);
      },
    };
    render(<App api={api} initialAnchor="2026-11-16" />);
    expect(await screen.findByText("2026-11-16 〜 2026-11-22")).toBeInTheDocument();
    expect(rangeCalls[0]).toEqual({
      from: "2026-11-16",
      to: "2026-11-22",
      viewId: "view-timeline",
    });
    await waitFor(() => expect(document.querySelectorAll(".timeline-day-column")).toHaveLength(7));
    // Issuing is the rows layouts' only (DESIGN 4.8.1: L5 is
    // screen-only), as with the year table and the grid.
    expect(screen.queryByRole("button", { name: "発行・印刷" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    expect(await screen.findByText("2026-11-23 〜 2026-11-29")).toBeInTheDocument();
    expect(rangeCalls[rangeCalls.length - 1]).toEqual({
      from: "2026-11-23",
      to: "2026-11-29",
      viewId: "view-timeline",
    });
  });
});

describe("the public screen with a timeline view", () => {
  it("renders the timeline read-only: entries visible, no way to write", async () => {
    const view: ViewDefinitionData = { ...timelineView, audience: "guardian" };
    const boot: PublicBootstrapData = {
      school: { id: "school-1", name: "テスト学校" },
      view,
      itemDefinitions: makeBootstrap().itemDefinitions,
      targetGroups: [],
      grades: GRADES,
      holidays: [],
    };
    const range = makeRange(view, {
      events: [
        eventOn("ev-1", "2026-11-16", "運動会", {
          kind: "clock",
          startsAt: "09:00",
          endsAt: "12:00",
        }),
      ],
    });
    const api: PublicApi = {
      getPublicBootstrap: async () => structuredClone(boot),
      getPublicRange: async () => structuredClone(range),
    };
    render(<PublicApp api={api} />);
    expect(await screen.findByText(/運動会/)).toBeInTheDocument();
    expect(document.querySelectorAll(".timeline-slot")).toHaveLength(0);
    expect(screen.queryByLabelText(/終日予定を追加/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "発行・印刷" })).not.toBeInTheDocument();
  });
});
