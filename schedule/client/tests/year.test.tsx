import "@testing-library/jest-dom/vitest";
import { datesInRange } from "@school-manage/calendar-types";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { ScheduleApi } from "../src/api";
import type { CellEditorContext } from "../src/cells";
import { createDevApi } from "../src/devAdapter";
import { rangeFor, schoolYearMonths, stepAnchor, yearLabel } from "../src/lib";
import { YearTable } from "../src/YearTable";
import type {
  BootstrapData,
  RangeData,
  RangeDayData,
  ViewColumnData,
  ViewDefinitionData,
} from "../src/types";

afterEach(cleanup);

// Year table tests (Issue #42): the L3 year_columns view — twelve
// month blocks side by side in one table, rows aligned by day of
// the month, empty cells for the dates a month does not have,
// and direct input only on the columns the view displays
// (DESIGN schedule 4.8.1). The fixtures follow input.test.tsx's
// shapes; the range is built date by date the way getRange
// bundles it (one day per real date).

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
    viewDefinitionId: "view-year",
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

/** The year view of the fixtures: events, lunch and the day duty.
 *  The dismissal item exists in the bootstrap but is NOT a column
 *  of this view — the narrowed set an L3 view is expected to
 *  carry (DESIGN schedule 4.8.1). */
const yearView: ViewDefinitionData = {
  id: "view-year",
  name: "職員用年間表",
  layout: "year_columns",
  layoutParams: null,
  audience: "staff",
  periodScope: "year",
  printSettings: null,
  isArchived: false,
  columns: [
    column("col-events", "event_category", 1),
    column("col-lunch", "daily_item", 2, { itemDefinitionId: "item-lunch" }),
    column("col-duty", "duty", 3, { dutyDefinitionId: "duty-day" }),
  ],
};

function makeBootstrap(): BootstrapData {
  const item = (
    id: string,
    key: string,
    name: string,
    valueType: string,
    sort: number,
    extra: Partial<BootstrapData["itemDefinitions"][number]> = {},
  ): BootstrapData["itemDefinitions"][number] => ({
    id,
    key,
    name,
    valueType,
    targetGroupId: null,
    targetPlatformAxis: null,
    granularity: "day",
    defaultVisibility: "staff_only",
    sort,
    options: [],
    ...extra,
  });
  return {
    school: { id: "school-1", name: "テスト学校" },
    userId: "user-1",
    teacherId: "staff-1",
    role: "Editor",
    permissions: ["view.read", "daily.write", "event.write"],
    views: [yearView],
    itemDefinitions: [
      item("item-lunch", "lunch", "給食", "symbol", 1, {
        options: [
          { id: "opt-lunch-yes", code: "yes", label: "○", sort: 1 },
          { id: "opt-lunch-no", code: "no", label: "×", sort: 2 },
        ],
      }),
      item("item-dismissal", "dismissal", "下校", "time", 2, {
        targetPlatformAxis: "grade",
      }),
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
    ],
    dutyDefinitions: [
      {
        id: "duty-day",
        name: "日番",
        granularity: "day",
        applicablePeriod: "all_year",
        applicableStartsOn: null,
        applicableEndsOn: null,
        targetGroupId: null,
        sort: 1,
        isActive: true,
        rotation: null,
      },
    ],
    locations: [],
    absenceSubdivisions: [],
    inputOpener: "popover",
    masters: { staff: STAFF, grades: GRADES, dayPatterns: [] },
  };
}

function eventOn(date: string, title: string): Record<string, unknown> {
  return {
    id: `ev-${date}`,
    kind: "event",
    kindLabel: null,
    title,
    datePrecision: "day",
    startsOn: date,
    endsOn: date,
    time: null,
    certainty: "confirmed",
    assignees: [],
    revision: 1,
  };
}

/** One school year's range bundle, as getRange returns it: one
 *  day per real date of the year, April 1 to March 31. */
function makeRange(
  view: ViewDefinitionData,
  schoolYear: number,
  eventsByDate: Record<string, Record<string, unknown>[]> = {},
): RangeData {
  const from = `${schoolYear}-04-01`;
  const to = `${schoolYear + 1}-03-31`;
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
    holidays: [],
    events: eventsByDate[date] ?? [],
    absences: [],
    dailyValues: [],
    dutyAssignments: [],
  }));
  return { view, from, to, days, undecided: [], eventValues: [], conflicts: [], monthNotes: [] };
}

const COLS_PER_BLOCK = yearView.columns.length + 1; // date cell + columns

/** The cells of one month block within one day row: the date
 *  header followed by the view's column cells. Blocks run April
 *  (0) to March (11). */
function blockCells(row: Element, blockIndex: number): Element[] {
  const start = blockIndex * COLS_PER_BLOCK;
  return [...row.children].slice(start, start + COLS_PER_BLOCK);
}

function dayRow(dayNum: number): Element {
  const row = document.querySelector(`tbody tr[data-day="${dayNum}"]`);
  if (!row) throw new Error(`no row for day ${dayNum}`);
  return row;
}

describe("lib: the year view's period", () => {
  it("asks getRange for the whole school year of the anchor", () => {
    expect(rangeFor(yearView, "2026-11-15")).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    // January–March belong to the school year that began the
    // previous April.
    expect(rangeFor(yearView, "2027-02-15")).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(rangeFor(yearView, "2027-04-01")).toEqual({ from: "2027-04-01", to: "2028-03-31" });
  });

  it("steps by whole years and labels the period 年度", () => {
    // addMonths lands on the month's first day, as it does for
    // the month view: the anchor is a month pointer.
    expect(stepAnchor(yearView, "2026-11-15", 1)).toBe("2027-11-01");
    expect(stepAnchor(yearView, "2026-11-15", -1)).toBe("2025-11-01");
    expect(yearLabel("2026-11-15")).toBe("2026年度");
    expect(yearLabel("2027-01-15")).toBe("2026年度");
  });

  it("lists the school year's months April first, March last", () => {
    const months = schoolYearMonths(2026);
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ year: 2026, month: 4 });
    expect(months[8]).toEqual({ year: 2026, month: 12 });
    expect(months[9]).toEqual({ year: 2027, month: 1 });
    expect(months[11]).toEqual({ year: 2027, month: 3 });
  });
});

describe("YearTable: the twelve blocks and their empty cells", () => {
  it("draws twelve month blocks, April to March, over 31 day rows", () => {
    render(<YearTable bootstrap={makeBootstrap()} range={makeRange(yearView, 2026)} />);
    const heads = [...document.querySelectorAll("thead .year-month-head")].map(
      (th) => th.textContent,
    );
    expect(heads).toEqual([
      "4月",
      "5月",
      "6月",
      "7月",
      "8月",
      "9月",
      "10月",
      "11月",
      "12月",
      "1月",
      "2月",
      "3月",
    ]);
    expect(document.querySelectorAll("tbody tr")).toHaveLength(31);
    // The view's columns repeat in every block; an item the view
    // does not carry （下校） is nowhere.
    expect(screen.getAllByText("行事")).toHaveLength(12);
    expect(screen.getAllByText("給食")).toHaveLength(12);
    expect(screen.getAllByText("日番")).toHaveLength(12);
    expect(screen.queryByText("下校")).not.toBeInTheDocument();
  });

  it("leaves February's and April's missing dates empty (school year 2026)", () => {
    render(
      <YearTable
        bootstrap={makeBootstrap()}
        range={makeRange(yearView, 2026, {
          "2026-04-30": [eventOn("2026-04-30", "入学式")],
        })}
      />,
    );
    // April (block 0) has a 30th: the date stands, with its event.
    const apr30 = blockCells(dayRow(30), 0);
    expect(apr30[0]).toHaveAttribute("data-date", "2026-04-30");
    expect(apr30[1]).toHaveTextContent("入学式");
    // April has no 31st: the whole block is empty cells.
    const apr31 = blockCells(dayRow(31), 0);
    expect(apr31[0]).not.toHaveAttribute("data-date");
    expect(apr31[0]).toHaveClass("no-date");
    for (const cell of apr31.slice(1)) {
      expect(cell).toHaveClass("no-date");
      expect(cell).toBeEmptyDOMElement();
    }
    // February 2027 (block 10) has 28 days: the 28th stands…
    const feb28 = blockCells(dayRow(28), 10);
    expect(feb28[0]).toHaveAttribute("data-date", "2027-02-28");
    // …and the 29th, 30th and 31st are empty.
    for (const dayNum of [29, 30, 31]) {
      const cells = blockCells(dayRow(dayNum), 10);
      expect(cells[0]).not.toHaveAttribute("data-date");
      expect(cells[0]).toHaveClass("no-date");
      for (const cell of cells.slice(1)) {
        expect(cell).toHaveClass("no-date");
        expect(cell).toBeEmptyDOMElement();
      }
    }
    // The other 30-day months (June, September, November) lose
    // only their 31st.
    for (const block of [2, 5, 7]) {
      expect(blockCells(dayRow(31), block)[0]).toHaveClass("no-date");
      expect(blockCells(dayRow(30), block)[0]).toHaveAttribute(
        "data-date",
        expect.stringMatching(/-30$/),
      );
    }
  });

  it("gives a leap-year February its 29th (school year 2027)", () => {
    render(<YearTable bootstrap={makeBootstrap()} range={makeRange(yearView, 2027)} />);
    // February 2028 is a leap February: the 29th is a real date…
    const feb29 = blockCells(dayRow(29), 10);
    expect(feb29[0]).toHaveAttribute("data-date", "2028-02-29");
    expect(feb29[0]).not.toHaveClass("no-date");
    // …and the year still totals 366 days of real date cells.
    expect(document.querySelectorAll("tbody th[data-date]")).toHaveLength(366);
    for (const dayNum of [30, 31]) {
      expect(blockCells(dayRow(dayNum), 10)[0]).toHaveClass("no-date");
    }
  });
});

describe("YearTable: input only on the displayed columns", () => {
  function renderWithEditor() {
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
      <YearTable bootstrap={makeBootstrap()} range={makeRange(yearView, 2026)} editor={editor} />,
    );
    return { createEvent, onSaved };
  }

  it("opens input in a displayed column's cell and saves against its date", async () => {
    const { createEvent, onSaved } = renderWithEditor();
    // February block (10), day 26, the events column.
    const feb26Events = blockCells(dayRow(26), 10)[1] as HTMLElement;
    fireEvent.click(feb26Events);
    const input = within(feb26Events).getByLabelText("行事の入力（2027-02-26）");
    fireEvent.change(input, { target: { value: "卒業式" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    expect(createEvent.mock.calls[0]?.[0].event).toMatchObject({
      title: "卒業式",
      startsOn: "2027-02-26",
      endsOn: "2027-02-26",
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("offers input on no other cells: not the hidden item, not duty, not a missing date", () => {
    renderWithEditor();
    // Focusable cells are exactly the editable columns (events +
    // lunch) of the real dates: the duty column displays but
    // never takes input, and 下校 is not a column of this view
    // at all, so no cell of it exists to focus.
    const focusable = document.querySelectorAll('tbody td[tabindex="0"]');
    expect(focusable).toHaveLength(365 * 2);
    // The duty cell of a real date is not focusable, and clicking
    // it opens nothing.
    const apr15Duty = blockCells(dayRow(15), 0)[3] as HTMLElement;
    expect(apr15Duty).not.toHaveAttribute("tabindex");
    fireEvent.click(apr15Duty);
    expect(document.querySelector("tbody input")).not.toBeInTheDocument();
    // A missing date's cells are not focusable either, and a
    // click there opens nothing.
    const feb30Events = blockCells(dayRow(30), 10)[1] as HTMLElement;
    expect(feb30Events).not.toHaveAttribute("tabindex");
    fireEvent.click(feb30Events);
    expect(document.querySelector("tbody input")).not.toBeInTheDocument();
  });
});

describe("the schedule screen with a year view", () => {
  it("reads the whole school year, labels it, and steps by years", async () => {
    const bootstrap = makeBootstrap();
    const rangeCalls: { from: string; to: string; viewId: string }[] = [];
    const api: ScheduleApi = {
      ...createDevApi(),
      getBootstrap: async () => bootstrap,
      getRange: async (input) => {
        rangeCalls.push(input);
        return makeRange(yearView, Number(input.from.slice(0, 4)));
      },
    };
    render(<App api={api} initialAnchor="2026-11-15" />);
    expect(await screen.findByText("2026年度")).toBeInTheDocument();
    await waitFor(() =>
      expect(rangeCalls[0]).toEqual({
        from: "2026-04-01",
        to: "2027-03-31",
        viewId: "view-year",
      }),
    );
    await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(31));
    // Issuing is the rows layouts' for now: no publish button on
    // the year table.
    expect(screen.queryByRole("button", { name: "発行・印刷" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    expect(await screen.findByText("2027年度")).toBeInTheDocument();
    await waitFor(() =>
      expect(rangeCalls[rangeCalls.length - 1]).toEqual({
        from: "2027-04-01",
        to: "2028-03-31",
        viewId: "view-year",
      }),
    );
  });
});
