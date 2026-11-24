import "@testing-library/jest-dom/vitest";
import { datesInRange } from "@school-manage/calendar-types";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { ScheduleApi } from "../src/api";
import { CalendarGrid } from "../src/CalendarGrid";
import type { CellEditorContext } from "../src/cells";
import { createDevApi } from "../src/devAdapter";
import { barLanes, calendarWeeks, gridWeekStart, rangeFor, stepAnchor } from "../src/lib";
import type {
  BootstrapData,
  DailyValueData,
  RangeData,
  RangeDayData,
  ViewColumnData,
  ViewDefinitionData,
} from "../src/types";

afterEach(cleanup);

// Calendar grid tests (Issue #43): the L4 calendar_grid view —
// a month folded at the week, each day cell capped with the
// rest as 「他○件」, multi-day entries connected by period
// bars, and input that starts by selecting a day cell and then
// follows the other layouts' flow (DESIGN schedule 4.8.1). The
// fixtures follow year.test.tsx's shapes; the range is built
// date by date the way getRange bundles it — a spanning entry
// stands in every day of its span, as the server places it.

const STAFF = [
  { id: "staff-1", name: "田中一郎" },
  { id: "staff-2", name: "佐藤花" },
];
const GRADES = [
  { id: "grade-1", name: "1年" },
  { id: "grade-2", name: "2年" },
];

function column(
  id: string,
  sourceKind: ViewColumnData["sourceKind"],
  sort: number,
  extra: Partial<ViewColumnData> = {},
): ViewColumnData {
  return {
    id,
    viewDefinitionId: "view-calendar",
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

/** The calendar view of the fixtures: events and lunch — the
 *  narrowed set an L4 view is expected to carry (DESIGN
 *  schedule 4.8.1). No weekStart: the weeks start on Monday,
 *  the school default. */
const calendarView: ViewDefinitionData = {
  id: "view-calendar",
  name: "職員用カレンダー",
  layout: "calendar_grid",
  layoutParams: null,
  audience: "staff",
  periodScope: "month",
  printSettings: null,
  isArchived: false,
  columns: [
    column("col-events", "event_category", 1),
    column("col-lunch", "daily_item", 2, { itemDefinitionId: "item-lunch" }),
  ],
};

const sundayView: ViewDefinitionData = {
  ...calendarView,
  id: "view-calendar-sun",
  layoutParams: { weekStart: 0 },
};

function makeBootstrap(views: ViewDefinitionData[] = [calendarView]): BootstrapData {
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
    absenceSubdivisions: [],
    inputOpener: "popover",
    masters: { staff: STAFF, grades: GRADES, dayPatterns: [] },
  };
}

function eventOn(id: string, start: string, end: string, title: string): Record<string, unknown> {
  return {
    id,
    kind: "event",
    kindLabel: null,
    title,
    datePrecision: "day",
    startsOn: start,
    endsOn: end,
    time: null,
    certainty: "confirmed",
    assignees: [],
    revision: 1,
  };
}

function absenceOn(
  id: string,
  from: string,
  to: string,
  staffId = "staff-2",
): Record<string, unknown> {
  return {
    id,
    kind: "leave",
    staffId,
    fromDate: from,
    toDate: to,
    purpose: null,
    note: null,
    revision: 1,
  };
}

interface RangeFixture {
  events?: Record<string, unknown>[];
  absences?: Record<string, unknown>[];
  lunchYes?: string[];
  holidays?: Record<string, string>;
}

/** November 2026's padded-month bundle for a view, as getRange
 *  returns it: one day per date of rangeFor, a spanning entry
 *  standing in every day of its span. */
function makeRange(view: ViewDefinitionData, fixture: RangeFixture = {}): RangeData {
  const { from, to } = rangeFor(view, "2026-11-15");
  const inSpan = (date: string, start: string, end: string) => date >= start && date <= end;
  const days: RangeDayData[] = datesInRange(from, to).map((date) => ({
    date,
    day: {
      date,
      dayType: "class_day",
      dayTypeLabel: null,
      dayScheduleId: null,
      weekdaySwap: null,
      note: null,
      source: "default",
    },
    holidays: fixture.holidays?.[date] ? [{ name: fixture.holidays[date] }] : [],
    events: (fixture.events ?? []).filter((e) =>
      inSpan(date, e["startsOn"] as string, e["endsOn"] as string),
    ),
    absences: (fixture.absences ?? []).filter((a) =>
      inSpan(date, a["fromDate"] as string, a["toDate"] as string),
    ),
    dailyValues: (fixture.lunchYes ?? []).includes(date)
      ? [
          {
            id: `dv-${date}`,
            date,
            itemDefinitionId: "item-lunch",
            targetId: null,
            targetRef: null,
            slot: "",
            valueText: null,
            valueTime: null,
            valueTimeEnd: null,
            valueNumber: null,
            valueBoolean: null,
            valueOptionId: "opt-lunch-yes",
            valuePersonId: null,
          } satisfies DailyValueData,
        ]
      : [],
    dutyAssignments: [],
  }));
  return { view, from, to, days, undecided: [], eventValues: [], conflicts: [], monthNotes: [] };
}

function cell(date: string): HTMLElement {
  const el = document.querySelector(`.grid-cell[data-date="${date}"]`);
  if (!el) throw new Error(`no grid cell for ${date}`);
  return el as HTMLElement;
}

describe("lib: the calendar view's period and week start", () => {
  it("pads the month to whole Monday-start weeks", () => {
    // November 2026: the 1st is a Sunday and the 30th a Monday,
    // so the padded month runs Oct 26 to Dec 6 — six weeks.
    expect(rangeFor(calendarView, "2026-11-15")).toEqual({ from: "2026-10-26", to: "2026-12-06" });
    const weeks = calendarWeeks(calendarView, "2026-11-15");
    expect(weeks).toHaveLength(6);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]?.[0]).toBe("2026-10-26");
    expect(weeks[5]?.[6]).toBe("2026-12-06");
  });

  it("follows the view's week-start setting", () => {
    // A Sunday start: the 1st is itself a Sunday, so the padded
    // month runs Nov 1 to Dec 5.
    expect(rangeFor(sundayView, "2026-11-15")).toEqual({ from: "2026-11-01", to: "2026-12-05" });
    expect(calendarWeeks(sundayView, "2026-11-15")[0]?.[0]).toBe("2026-11-01");
    // The weekday code reads as itself, and the number as the
    // JS weekday number (7 also Sunday, its ISO reading).
    expect(gridWeekStart({ ...calendarView, layoutParams: { weekStart: "sun" } })).toBe("sun");
    expect(gridWeekStart({ ...calendarView, layoutParams: { weekStart: 5 } })).toBe("fri");
    expect(gridWeekStart({ ...calendarView, layoutParams: { weekStart: 7 } })).toBe("sun");
    // Anything else falls back to the school default, Monday.
    expect(gridWeekStart(calendarView)).toBe("mon");
    expect(gridWeekStart({ ...calendarView, layoutParams: { weekStart: "x" } })).toBe("mon");
  });

  it("steps by months", () => {
    expect(stepAnchor(calendarView, "2026-11-15", 1)).toBe("2026-12-01");
    expect(stepAnchor(calendarView, "2026-11-15", -1)).toBe("2026-10-01");
  });

  it("packs period bars into lanes: overlaps split, sequences share", () => {
    const { laneOf, laneCount } = barLanes(
      [
        { id: "a", start: "2026-11-10", end: "2026-11-12" },
        { id: "b", start: "2026-11-11", end: "2026-11-13" },
        { id: "c", start: "2026-11-13", end: "2026-11-14" },
      ],
      "2026-11-09",
    );
    expect(laneCount).toBe(2);
    expect(laneOf.get("a")).toBe(0);
    expect(laneOf.get("b")).toBe(1);
    // c starts the day after a ends: it takes a's lane back.
    expect(laneOf.get("c")).toBe(0);
  });
});

describe("CalendarGrid: the month's shape", () => {
  it("draws the weekday head in the view's week-start order", () => {
    render(
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView)}
        anchor="2026-11-15"
      />,
    );
    const heads = [...document.querySelectorAll(".grid-weekday")].map((el) => el.textContent);
    expect(heads).toEqual(["月", "火", "水", "木", "金", "土", "日"]);
    expect(document.querySelectorAll(".grid-cell")).toHaveLength(42);
  });

  it("starts the head on Sunday for a Sunday-start view", () => {
    render(
      <CalendarGrid
        bootstrap={makeBootstrap([sundayView])}
        range={makeRange(sundayView)}
        anchor="2026-11-15"
      />,
    );
    const heads = [...document.querySelectorAll(".grid-weekday")].map((el) => el.textContent);
    expect(heads).toEqual(["日", "月", "火", "水", "木", "金", "土"]);
    expect(document.querySelectorAll(".grid-cell")).toHaveLength(35);
  });

  it("dims the padding days of the neighbouring months", () => {
    render(
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView)}
        anchor="2026-11-15"
      />,
    );
    expect(cell("2026-10-26")).toHaveClass("outside");
    expect(cell("2026-12-06")).toHaveClass("outside");
    expect(cell("2026-11-01")).not.toHaveClass("outside");
    expect(cell("2026-11-30")).not.toHaveClass("outside");
  });

  it("names a holiday in its cell, and shows the day's lunch mark compactly", () => {
    render(
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView, {
          holidays: { "2026-11-03": "文化の日" },
          lunchYes: ["2026-11-16"],
        })}
        anchor="2026-11-15"
      />,
    );
    expect(cell("2026-11-03")).toHaveTextContent("文化の日");
    expect(cell("2026-11-03")).toHaveClass("kind-holiday");
    expect(cell("2026-11-16")).toHaveTextContent("給食：○");
  });
});

describe("CalendarGrid: the cell cap and 「他○件」", () => {
  it("shows three entries and counts the rest as 他○件", () => {
    const events = ["朝会", "委員会", "避難訓練", "研究授業", "PTA総会"].map((title, i) =>
      eventOn(`ev-${i}`, "2026-11-16", "2026-11-16", title),
    );
    render(
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView, { events })}
        anchor="2026-11-15"
      />,
    );
    const c = cell("2026-11-16");
    expect(within(c).getAllByText(/^(朝会|委員会|避難訓練)$/)).toHaveLength(3);
    expect(within(c).getByText("他2件")).toBeInTheDocument();
    // The hidden two are not lines of the cell.
    expect(within(c).queryByText("研究授業")).not.toBeInTheDocument();
    expect(within(c).queryByText("PTA総会")).not.toBeInTheDocument();
  });

  it("shows no overflow line when the day fits the cap", () => {
    const events = [eventOn("ev-1", "2026-11-16", "2026-11-16", "朝会")];
    render(
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView, { events })}
        anchor="2026-11-15"
      />,
    );
    expect(cell("2026-11-16")).toHaveTextContent("朝会");
    expect(document.querySelector(".grid-more")).not.toBeInTheDocument();
  });
});

describe("CalendarGrid: period bars", () => {
  it("connects a multi-day event with one bar across its days", () => {
    const events = [eventOn("ev-trip", "2026-11-10", "2026-11-12", "修学旅行")];
    render(
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView, { events })}
        anchor="2026-11-15"
      />,
    );
    const bars = document.querySelectorAll(".grid-bar");
    expect(bars).toHaveLength(1);
    const bar = bars[0] as HTMLElement;
    expect(bar).toHaveTextContent("修学旅行");
    expect(bar.dataset["start"]).toBe("2026-11-10");
    expect(bar.dataset["end"]).toBe("2026-11-12");
    // The week of Nov 9–15: Tuesday to Thursday is columns 2–4.
    expect(bar.style.gridColumn).toBe("2 / 5");
    expect(bar).toHaveClass("bar-start");
    expect(bar).toHaveClass("bar-end");
    // The bar is the entry's only drawing: no cell repeats it.
    expect(cell("2026-11-11")).not.toHaveTextContent("修学旅行");
  });

  it("draws a spanning absence as a bar too", () => {
    const absences = [absenceOn("ab-1", "2026-11-18", "2026-11-20")];
    render(
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView, { absences })}
        anchor="2026-11-15"
      />,
    );
    const bars = document.querySelectorAll(".grid-bar");
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveTextContent("佐藤花");
    expect((bars[0] as HTMLElement).dataset["start"]).toBe("2026-11-18");
  });

  it("cuts a bar at the week boundary and draws it in both weeks", () => {
    // Friday Nov 13 to Tuesday Nov 17 crosses the Sunday.
    const events = [eventOn("ev-camp", "2026-11-13", "2026-11-17", "合宿")];
    render(
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView, { events })}
        anchor="2026-11-15"
      />,
    );
    const bars = [...document.querySelectorAll(".grid-bar")];
    expect(bars).toHaveLength(2);
    // The first week's piece ends at the boundary: it starts
    // the entry but does not end it, and vice versa.
    expect(bars[0]).toHaveClass("bar-start");
    expect(bars[0]).not.toHaveClass("bar-end");
    expect(bars[1]).not.toHaveClass("bar-start");
    expect(bars[1]).toHaveClass("bar-end");
  });

  it("stacks overlapping bars in separate lanes", () => {
    const events = [
      eventOn("ev-a", "2026-11-10", "2026-11-12", "修学旅行"),
      eventOn("ev-b", "2026-11-11", "2026-11-13", "職場体験"),
    ];
    render(
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView, { events })}
        anchor="2026-11-15"
      />,
    );
    expect(document.querySelectorAll(".grid-bar-lane")).toHaveLength(2);
    expect(document.querySelectorAll(".grid-bar")).toHaveLength(2);
  });
});

describe("CalendarGrid: the day detail and input", () => {
  function renderWithEditor(fixture: RangeFixture = {}) {
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
      <CalendarGrid
        bootstrap={makeBootstrap()}
        range={makeRange(calendarView, fixture)}
        anchor="2026-11-15"
        editor={editor}
      />,
    );
    return { createEvent, onSaved };
  }

  it("opens the day's detail on a cell click, listing the day as one rows-table day", async () => {
    renderWithEditor({ events: [eventOn("ev-1", "2026-11-16", "2026-11-16", "避難訓練")] });
    fireEvent.click(cell("2026-11-16"));
    const dialog = await screen.findByRole("dialog", { name: "11/16（月） の詳細" });
    expect(within(dialog).getByText("避難訓練")).toBeInTheDocument();
    // The day's columns are the view's: events and lunch.
    expect(dialog.querySelector("thead")).toHaveTextContent("行事");
    expect(dialog.querySelector("thead")).toHaveTextContent("給食");
  });

  it("opens the day's detail from the keyboard: focus the cell, press Enter", async () => {
    renderWithEditor({ events: [eventOn("ev-1", "2026-11-16", "2026-11-16", "避難訓練")] });
    const c = screen.getByRole("button", { name: "11月16日の詳細" });
    c.focus();
    expect(c).toHaveFocus();
    fireEvent.keyDown(c, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", { name: "11/16（月） の詳細" });
    expect(within(dialog).getByText("避難訓練")).toBeInTheDocument();
    // Input has begun, exactly as with a click.
    expect(within(dialog).getByLabelText("行事の入力（2026-11-16）")).toBeInTheDocument();
  });

  it("creates an event from a day cell: select the day, type, Enter", async () => {
    const { createEvent, onSaved } = renderWithEditor();
    fireEvent.click(cell("2026-11-16"));
    const dialog = await screen.findByRole("dialog", { name: "11/16（月） の詳細" });
    // Selecting the day started input: the entry input is
    // already open in the day detail, as the design's L4 input
    // prescribes （日マスを選んで入力開始）.
    const input = within(dialog).getByLabelText("行事の入力（2026-11-16）");
    fireEvent.change(input, { target: { value: "全校集会" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0]?.[0].event).toMatchObject({
      title: "全校集会",
      startsOn: "2026-11-16",
      endsOn: "2026-11-16",
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("opens the detail modal from a period bar, as in the other layouts", async () => {
    renderWithEditor({ events: [eventOn("ev-trip", "2026-11-10", "2026-11-12", "修学旅行")] });
    const bar = document.querySelector(".grid-bar") as HTMLElement;
    fireEvent.click(bar);
    const dialog = await screen.findByRole("dialog", { name: "行事の詳細" });
    expect(await within(dialog).findByDisplayValue("修学旅行")).toBeInTheDocument();
    // The bar's click did not also open the day detail behind it.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("opens the day detail from the overflow line as well", async () => {
    const events = ["朝会", "委員会", "避難訓練", "研究授業"].map((title, i) =>
      eventOn(`ev-${i}`, "2026-11-16", "2026-11-16", title),
    );
    renderWithEditor({ events });
    fireEvent.click(within(cell("2026-11-16")).getByText("他1件"));
    const dialog = await screen.findByRole("dialog", { name: "11/16（月） の詳細" });
    // In the detail, every entry of the day reads — including
    // the one the cell capped away.
    expect(within(dialog).getByText("研究授業")).toBeInTheDocument();
  });
});

describe("the schedule screen with a calendar view", () => {
  it("reads the padded month, labels it by month, and offers the publish button (Issue #49)", async () => {
    const bootstrap = makeBootstrap();
    const rangeCalls: { from: string; to: string; viewId: string }[] = [];
    const api: ScheduleApi = {
      ...createDevApi(),
      getBootstrap: async () => bootstrap,
      getSummary: async (): Promise<never> => {
        throw new Error("not used");
      },
      getRange: async (input) => {
        rangeCalls.push(input);
        return makeRange(calendarView);
      },
    };
    render(<App api={api} initialAnchor="2026-11-15" />);
    expect(await screen.findByText("2026年11月")).toBeInTheDocument();
    await waitFor(() =>
      expect(rangeCalls[0]).toEqual({
        from: "2026-10-26",
        to: "2026-12-06",
        viewId: "view-calendar",
      }),
    );
    await waitFor(() => expect(document.querySelectorAll(".grid-cell")).toHaveLength(42));
    // Issue #49 issues the calendar too: the publish button
    // stands on the grid (its document prints the whole month,
    // uncapped).
    expect(screen.getByRole("button", { name: "発行・印刷" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    expect(await screen.findByText("2026年12月")).toBeInTheDocument();
    await waitFor(() =>
      expect(rangeCalls[rangeCalls.length - 1]).toEqual({
        from: "2026-11-30",
        to: "2027-01-03",
        viewId: "view-calendar",
      }),
    );
  });
});
