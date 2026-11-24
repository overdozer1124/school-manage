import "@testing-library/jest-dom/vitest";
import { datesInRange } from "@school-manage/calendar-types";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { PublicApi, ScheduleApi } from "../src/api";
import type { CellEditorContext } from "../src/cells";
import { createDevApi } from "../src/devAdapter";
import { rangeFor, stepAnchor, transposedModel } from "../src/lib";
import { PublicApp } from "../src/PublicApp";
import { RowsTable } from "../src/RowsTable";
import { TransposedTable } from "../src/TransposedTable";
import type {
  BootstrapData,
  DailyValueData,
  DefinitionSetData,
  PublicBootstrapData,
  RangeData,
  RangeDayData,
  ViewColumnData,
  ViewDefinitionData,
} from "../src/types";

afterEach(cleanup);

// Transposed table tests (Issue #45): rows are the members of
// the view's target axis, columns are the days, and each cell
// is that target's daily value — the same per-target datum the
// L1 table groups into one cell (DESIGN schedule 4.8 / 4.8.2,
// 5.2 scenario 5). The fixture definitions are the junior-high
// preset's, as the server ships them in
// schedule/src/definitions/presets.ts: the 部活動 axis (the
// preset ships it without targets — the school adds its own
// clubs), the per-club item 部活動（部別）with the club symbols
// 練/休/大/前/後/ミ, and the whole-school 部活動 item.

const STAFF = [
  { id: "staff-1", name: "田中一郎" },
  { id: "staff-2", name: "佐藤花" },
];
const GRADES = [
  { id: "grade-1", name: "1年" },
  { id: "grade-2", name: "2年" },
];

const CLUB_OPTIONS = [
  { id: "opt-club-activity-practice", code: "practice", label: "練", sort: 1 },
  { id: "opt-club-activity-off", code: "off", label: "休", sort: 2 },
  { id: "opt-club-activity-tournament", code: "tournament", label: "大", sort: 3 },
  { id: "opt-club-activity-morning", code: "morning", label: "前", sort: 4 },
  { id: "opt-club-activity-afternoon", code: "afternoon", label: "後", sort: 5 },
  { id: "opt-club-activity-meeting", code: "meeting", label: "ミ", sort: 6 },
];

function column(
  id: string,
  sourceKind: ViewColumnData["sourceKind"],
  sort: number,
  extra: Partial<ViewColumnData> = {},
): ViewColumnData {
  return {
    id,
    viewDefinitionId: "view-club",
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

const clubView: ViewDefinitionData = {
  id: "view-club",
  name: "部活動表",
  layout: "transposed",
  layoutParams: null,
  audience: "staff",
  periodScope: "month",
  printSettings: null,
  isArchived: false,
  columns: [
    column("col-club", "daily_item", 1, {
      itemDefinitionId: "item-club-activity",
      targetGroupId: "tg-club",
    }),
  ],
};

const monthView: ViewDefinitionData = {
  id: "view-month",
  name: "職員用月表",
  layout: "month_rows",
  layoutParams: null,
  audience: "staff",
  periodScope: "month",
  printSettings: null,
  isArchived: false,
  columns: [
    column("col-events", "event_category", 1),
    column("col-club-month", "daily_item", 2, { itemDefinitionId: "item-club-activity" }),
  ],
};

function makeBootstrap(views: ViewDefinitionData[] = [clubView]): BootstrapData {
  return {
    school: { id: "school-1", name: "テスト中学校" },
    userId: "user-1",
    teacherId: "staff-1",
    role: "Editor",
    permissions: ["view.read", "daily.write", "event.write"],
    views,
    itemDefinitions: [
      {
        id: "item-club-activity",
        key: "club_activity",
        name: "部活動（部別）",
        valueType: "symbol",
        targetGroupId: "tg-club",
        targetPlatformAxis: null,
        granularity: "day",
        defaultVisibility: "staff_only",
        sort: 4,
        options: CLUB_OPTIONS,
      },
      {
        id: "item-club-day",
        key: "club_day",
        name: "部活動",
        valueType: "symbol",
        targetGroupId: null,
        targetPlatformAxis: null,
        granularity: "day",
        defaultVisibility: "guardian",
        sort: 3,
        options: CLUB_OPTIONS.map((o) => ({ ...o, id: o.id.replace("activity", "day") })),
      },
      {
        id: "item-lunch",
        key: "lunch",
        name: "給食",
        valueType: "symbol",
        targetGroupId: null,
        targetPlatformAxis: null,
        granularity: "day",
        defaultVisibility: "staff_only",
        sort: 2,
        options: [
          { id: "opt-lunch-yes", code: "yes", label: "○", sort: 1 },
          { id: "opt-lunch-no", code: "no", label: "×", sort: 2 },
        ],
      },
    ],
    targetGroups: [
      {
        id: "tg-club",
        key: "club",
        name: "部活動",
        sort: 1,
        targets: [
          {
            id: "tgt-club-baseball",
            targetGroupId: "tg-club",
            code: null,
            name: "野球部",
            sort: 1,
          },
          {
            id: "tgt-club-soccer",
            targetGroupId: "tg-club",
            code: null,
            name: "サッカー部",
            sort: 2,
          },
          { id: "tgt-club-brass", targetGroupId: "tg-club", code: null, name: "吹奏楽部", sort: 3 },
        ],
      },
    ],
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
    dutyDefinitions: [],
    locations: [],
    absenceSubdivisions: [],
    inputOpener: "popover",
    masters: { staff: STAFF, grades: GRADES, dayPatterns: [] },
  };
}

interface ValueFixture {
  date: string;
  itemId: string;
  targetId?: string | null;
  optionCode?: string;
}

interface RangeFixture {
  values?: ValueFixture[];
  events?: Record<string, unknown>[];
}

/** The range bundle for a view, as getRange returns it: one
 *  day per date of rangeFor, the fixture's daily values and
 *  events placed on their days. */
function makeRange(
  view: ViewDefinitionData,
  fixture: RangeFixture = {},
  anchor = "2026-11-16",
): RangeData {
  const bootstrap = makeBootstrap();
  const { from, to } = rangeFor(view, anchor);
  let seq = 0;
  const days: RangeDayData[] = datesInRange(from, to).map((date) => {
    const dailyValues: DailyValueData[] = (fixture.values ?? [])
      .filter((v) => v.date === date)
      .map((v) => {
        const item = bootstrap.itemDefinitions.find((i) => i.id === v.itemId);
        seq += 1;
        return {
          id: `dv-${seq}`,
          date,
          itemDefinitionId: v.itemId,
          targetId: v.targetId ?? null,
          targetRef: v.targetId
            ? { axis: "app", app: "schedule", axisKey: "club", id: v.targetId }
            : null,
          slot: "all_day",
          valueText: null,
          valueTime: null,
          valueTimeEnd: null,
          valueNumber: null,
          valueBoolean: null,
          valueOptionId: item?.options.find((o) => o.code === v.optionCode)?.id ?? null,
          valuePersonId: null,
        } as DailyValueData;
      });
    return {
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
      events: (fixture.events ?? []).filter((e) => e["startsOn"] === date && e["endsOn"] === date),
      absences: [],
      dailyValues,
      dutyAssignments: [],
    };
  });
  return { view, from, to, days, undecided: [], eventValues: [], conflicts: [], monthNotes: [] };
}

function cell(date: string, targetId: string): HTMLElement {
  const el = document.querySelector(
    `.transposed-cell[data-date="${date}"][data-target="${targetId}"]`,
  );
  if (!el) throw new Error(`no transposed cell for ${date} / ${targetId}`);
  return el as HTMLElement;
}

function rowOf(name: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>(".transposed-table tbody tr")].find(
    (tr) => tr.querySelector("th")?.textContent === name,
  );
  if (!el) throw new Error(`no transposed row for ${name}`);
  return el;
}

describe("lib: the transposed view's days and axis", () => {
  it("reads the period scope as the day span and steps by it", () => {
    // The month is the club table's scope.
    expect(rangeFor(clubView, "2026-11-16")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    // A month step lands on the next month's first day, as the
    // rows layouts' month step does (addMonths normalises).
    expect(stepAnchor(clubView, "2026-11-16", 1)).toBe("2026-12-01");
    expect(stepAnchor(clubView, "2026-11-16", -1)).toBe("2026-10-01");
    const weekView: ViewDefinitionData = { ...clubView, periodScope: "week" };
    expect(rangeFor(weekView, "2026-11-18")).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(stepAnchor(weekView, "2026-11-16", 1)).toBe("2026-11-23");
    const twoWeeks: ViewDefinitionData = { ...clubView, periodScope: "two_weeks" };
    expect(rangeFor(twoWeeks, "2026-11-18")).toEqual({ from: "2026-11-16", to: "2026-11-29" });
    const yearView: ViewDefinitionData = { ...clubView, periodScope: "year" };
    expect(rangeFor(yearView, "2026-11-16")).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(stepAnchor(yearView, "2026-11-16", 1)).toBe("2027-11-01");
  });

  it("takes the rows from the view's axis item and sets the other items aside", () => {
    const bootstrap = makeBootstrap();
    const mixed: ViewDefinitionData = {
      ...clubView,
      columns: [
        column("col-club-day", "daily_item", 1, { itemDefinitionId: "item-club-day" }),
        column("col-club", "daily_item", 2, {
          itemDefinitionId: "item-club-activity",
          targetGroupId: "tg-club",
        }),
        column("col-lunch", "daily_item", 3, { itemDefinitionId: "item-lunch" }),
      ],
    };
    const model = transposedModel(bootstrap, mixed.columns);
    expect(model?.axisItem.id).toBe("item-club-activity");
    expect(model?.axisLabel).toBe("部活動");
    expect(model?.entries.map((e) => e.name)).toEqual(["野球部", "サッカー部", "吹奏楽部"]);
    expect(model?.shown.map((s) => s.item.id)).toEqual(["item-club-activity"]);
    expect(model?.others.map((i) => i.id)).toEqual(["item-club-day", "item-lunch"]);
    // A view whose daily items range over no axis has no rows.
    const lunchOnly: ViewDefinitionData = {
      ...clubView,
      columns: [column("col-lunch", "daily_item", 1, { itemDefinitionId: "item-lunch" })],
    };
    expect(transposedModel(bootstrap, lunchOnly.columns)).toBeNull();
    // An axis item whose axis has no targets yet still reads
    // as the view's axis: the model stands with no rows, so
    // the table can say the targets are not registered yet.
    // The junior-high preset ships its club axis exactly this
    // way — the school adds its own clubs afterwards.
    const noTargets: BootstrapData = {
      ...bootstrap,
      targetGroups: bootstrap.targetGroups.map((g) => ({ ...g, targets: [] })),
    };
    const emptyModel = transposedModel(noTargets, clubView.columns);
    expect(emptyModel?.axisItem.id).toBe("item-club-activity");
    expect(emptyModel?.entries).toEqual([]);
    expect(emptyModel?.shown.map((s) => s.item.id)).toEqual(["item-club-activity"]);
  });
});

describe("TransposedTable: rows are targets, columns are days", () => {
  it("draws one row per club and one column per day of the month, values in their cells", () => {
    render(
      <TransposedTable
        bootstrap={makeBootstrap()}
        range={makeRange(clubView, {
          values: [
            {
              date: "2026-11-16",
              itemId: "item-club-activity",
              targetId: "tgt-club-baseball",
              optionCode: "practice",
            },
            {
              date: "2026-11-16",
              itemId: "item-club-activity",
              targetId: "tgt-club-soccer",
              optionCode: "morning",
            },
            {
              date: "2026-11-16",
              itemId: "item-club-activity",
              targetId: "tgt-club-brass",
              optionCode: "practice",
            },
            {
              date: "2026-11-21",
              itemId: "item-club-activity",
              targetId: "tgt-club-baseball",
              optionCode: "tournament",
            },
          ],
        })}
      />,
    );
    const rows = document.querySelectorAll(".transposed-table tbody tr");
    expect(rows).toHaveLength(3);
    expect(document.querySelectorAll(".transposed-table thead th")).toHaveLength(31);
    expect(cell("2026-11-16", "tgt-club-baseball")).toHaveTextContent("練");
    expect(cell("2026-11-16", "tgt-club-soccer")).toHaveTextContent("前");
    expect(cell("2026-11-21", "tgt-club-baseball")).toHaveTextContent("大");
    // A day with no value for the club stands empty in its row.
    expect(cell("2026-11-17", "tgt-club-baseball")).toHaveTextContent("");
    expect(rowOf("野球部")).toHaveTextContent("大");
    expect(rowOf("サッカー部")).not.toHaveTextContent("大");
  });

  it("stands a targetless value of a shown item in its own row", () => {
    render(
      <TransposedTable
        bootstrap={makeBootstrap()}
        range={makeRange(clubView, {
          values: [
            { date: "2026-11-18", itemId: "item-club-activity", targetId: null, optionCode: "off" },
          ],
        })}
      />,
    );
    expect(document.querySelectorAll(".transposed-table tbody tr")).toHaveLength(4);
    expect(cell("2026-11-18", "")).toHaveTextContent("休");
    expect(rowOf("（対象指定なし）")).toBeInTheDocument();
  });

  it("shows an event in the row of the target it names", () => {
    render(
      <TransposedTable
        bootstrap={makeBootstrap()}
        range={makeRange(clubView, {
          events: [
            {
              id: "ev-match",
              kind: "event",
              kindLabel: null,
              title: "サッカー大会",
              datePrecision: "day",
              startsOn: "2026-11-21",
              endsOn: "2026-11-21",
              time: null,
              certainty: "confirmed",
              targets: [{ axis: "app", app: "schedule", axisKey: "club", id: "tgt-club-soccer" }],
              assignees: [],
              revision: 1,
            },
          ],
        })}
      />,
    );
    const soccerRow = rowOf("サッカー部");
    expect(within(soccerRow).getByText("サッカー大会")).toBeInTheDocument();
    expect(rowOf("野球部")).not.toHaveTextContent("サッカー大会");
  });

  it("names the items it cannot draw, and says what a view without an axis item needs", () => {
    const mixed: ViewDefinitionData = {
      ...clubView,
      id: "view-mixed",
      columns: [
        column("col-club", "daily_item", 1, {
          itemDefinitionId: "item-club-activity",
          targetGroupId: "tg-club",
        }),
        column("col-lunch", "daily_item", 2, { itemDefinitionId: "item-lunch" }),
      ],
    };
    const { unmount } = render(
      <TransposedTable bootstrap={makeBootstrap([mixed])} range={makeRange(mixed)} />,
    );
    expect(
      screen.getByText(/給食 は、この転置表の対象軸（部活動）の項目ではないため/),
    ).toBeInTheDocument();
    unmount();

    const lunchOnly: ViewDefinitionData = {
      ...clubView,
      id: "view-lunch-only",
      columns: [column("col-lunch", "daily_item", 1, { itemDefinitionId: "item-lunch" })],
    };
    render(<TransposedTable bootstrap={makeBootstrap([lunchOnly])} range={makeRange(lunchOnly)} />);
    expect(
      screen.getByText(/転置表には、対象軸（学年・部活動など）を持つ日次項目の列が必要です/),
    ).toBeInTheDocument();
  });

  it("says the axis's targets are not registered yet when the axis stands empty", () => {
    const bootstrap = makeBootstrap();
    const empty: BootstrapData = {
      ...bootstrap,
      targetGroups: bootstrap.targetGroups.map((g) => ({ ...g, targets: [] })),
    };
    render(<TransposedTable bootstrap={empty} range={makeRange(clubView)} />);
    expect(screen.getByText(/「部活動」の対象がまだ登録されていません/)).toBeInTheDocument();
    expect(screen.queryByText(/対象軸（学年・部活動など）を持つ日次項目の列が必要です/)).toBeNull();
  });

  it("names the month where a multi-month span turns into it", () => {
    const yearView: ViewDefinitionData = {
      ...clubView,
      id: "view-club-year",
      periodScope: "year",
    };
    render(<TransposedTable bootstrap={makeBootstrap([yearView])} range={makeRange(yearView)} />);
    const head = (date: string) =>
      document.querySelector(`.transposed-table thead th[data-date="${date}"]`);
    expect(head("2026-04-01")).toHaveTextContent("4月");
    expect(head("2026-11-01")).toHaveTextContent("11月");
    expect(head("2026-11-16")).not.toHaveTextContent("11月");
    // A single month names no month: the label would repeat
    // what the screen already says.
    cleanup();
    render(<TransposedTable bootstrap={makeBootstrap()} range={makeRange(clubView)} />);
    expect(head("2026-11-01")).not.toHaveTextContent("11月");
  });

  it("is read-only without an editor: values visible, no input controls", () => {
    render(
      <TransposedTable
        bootstrap={makeBootstrap()}
        range={makeRange(clubView, {
          values: [
            {
              date: "2026-11-16",
              itemId: "item-club-activity",
              targetId: "tgt-club-baseball",
              optionCode: "practice",
            },
          ],
        })}
      />,
    );
    expect(cell("2026-11-16", "tgt-club-baseball")).toHaveTextContent("練");
    expect(document.querySelectorAll(".transposed-table select")).toHaveLength(0);
    expect(cell("2026-11-16", "tgt-club-baseball").getAttribute("tabindex")).toBeNull();
  });
});

describe("TransposedTable: input writes the one per-target datum", () => {
  it("saves the chosen symbol against the row's target through setDailyValue", async () => {
    const setCalls: unknown[] = [];
    const setDailyValue = vi.fn(async (input: unknown) => {
      setCalls.push(input);
      return {};
    });
    const api = { ...createDevApi(), setDailyValue } as unknown as ScheduleApi;
    const onSaved = vi.fn();
    const editor: CellEditorContext = { api, onSaved, onUnauthorizedError: () => undefined };
    render(
      <TransposedTable
        bootstrap={makeBootstrap()}
        range={makeRange(clubView, {
          values: [
            {
              date: "2026-11-17",
              itemId: "item-club-activity",
              targetId: "tgt-club-soccer",
              optionCode: "practice",
            },
          ],
        })}
        editor={editor}
      />,
    );
    fireEvent.click(cell("2026-11-17", "tgt-club-soccer"));
    const select = await screen.findByLabelText("部活動（部別）（サッカー部）");
    fireEvent.change(select, { target: { value: "tournament" } });
    await waitFor(() => expect(setDailyValue).toHaveBeenCalledTimes(1));
    expect(setCalls[0]).toEqual({
      date: "2026-11-17",
      itemDefinitionId: "item-club-activity",
      target: { axis: "app", app: "schedule", axisKey: "club", id: "tgt-club-soccer" },
      value: "tournament",
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("the value entered in the transposed table is the value the L1 table shows (one datum)", () => {
    // One store behind both tables: the transposed cell and the
    // L1 cell read the same day's daily values.
    const range = makeRange(monthView, {
      values: [
        {
          date: "2026-11-21",
          itemId: "item-club-activity",
          targetId: "tgt-club-baseball",
          optionCode: "tournament",
        },
        {
          date: "2026-11-21",
          itemId: "item-club-activity",
          targetId: "tgt-club-soccer",
          optionCode: "practice",
        },
        {
          date: "2026-11-21",
          itemId: "item-club-activity",
          targetId: "tgt-club-brass",
          optionCode: "practice",
        },
      ],
    });
    const bootstrap = makeBootstrap([clubView, monthView]);
    const { unmount } = render(<TransposedTable bootstrap={bootstrap} range={range} />);
    expect(cell("2026-11-21", "tgt-club-baseball")).toHaveTextContent("大");
    unmount();
    render(<RowsTable bootstrap={bootstrap} range={range} />);
    const dayRow = document.querySelector('tbody tr[data-date="2026-11-21"]') as HTMLElement;
    // The L1 cell groups the same per-target values (4.8.2):
    // the two 練 clubs group, the 大 club stands apart.
    expect(dayRow).toHaveTextContent("野球部 大／サッカー部・吹奏楽部 練");
  });
});

describe("TransposedTable: a character typed on a cell seeds its input", () => {
  it("keeps the first character in a per-target time cell opened by typing", async () => {
    const bootstrap = makeBootstrap();
    const gradeBootstrap: BootstrapData = {
      ...bootstrap,
      itemDefinitions: [
        ...bootstrap.itemDefinitions,
        {
          id: "item-dismissal-grade",
          key: "dismissal_grade",
          name: "下校時刻",
          valueType: "time",
          targetGroupId: "tg-grade",
          targetPlatformAxis: null,
          granularity: "day",
          defaultVisibility: "staff_only",
          sort: 5,
          options: [],
        },
      ],
      targetGroups: [
        ...bootstrap.targetGroups,
        {
          id: "tg-grade",
          key: "grade_group",
          name: "学年",
          sort: 2,
          targets: [
            { id: "tgt-grade-1", targetGroupId: "tg-grade", code: null, name: "1年", sort: 1 },
            { id: "tgt-grade-2", targetGroupId: "tg-grade", code: null, name: "2年", sort: 2 },
          ],
        },
      ],
    };
    const gradeView: ViewDefinitionData = {
      ...clubView,
      id: "view-grade",
      name: "学年別下校時刻",
      columns: [
        column("col-dismissal", "daily_item", 1, {
          itemDefinitionId: "item-dismissal-grade",
          targetGroupId: "tg-grade",
        }),
      ],
    };
    const setDailyValue = vi.fn(async () => ({}));
    const api = { ...createDevApi(), setDailyValue } as unknown as ScheduleApi;
    const editor: CellEditorContext = {
      api,
      onSaved: () => undefined,
      onUnauthorizedError: () => undefined,
    };
    render(
      <TransposedTable bootstrap={gradeBootstrap} range={makeRange(gradeView)} editor={editor} />,
    );
    fireEvent.keyDown(cell("2026-11-16", "tgt-grade-1"), { key: "1" });
    const input = await screen.findByLabelText("下校時刻（1年）");
    expect(input).toHaveValue("1");
  });
});

describe("scenario 5: the per-club table from the junior-high preset", () => {
  it("builds the club table through the definition APIs and writes into it in the app", async () => {
    const api = createDevApi();
    // The junior-high preset, applied the way the settings
    // screen applies it — read as a before/after difference,
    // so the assertions name what the preset itself brings.
    // This fixture school already runs a club programme (the
    // axis, its clubs and the per-club item are part of its
    // starting definitions, as DEV_BOOTSTRAP documents), so
    // the preset's own arrival here is the whole-school club
    // item: absent before, present after. The axis and the
    // per-club item the scenario rows on are in the applied
    // set; a school without them gets the axis from the
    // preset with no targets yet, as the server ships it.
    const before = (await api.getDefinitions()) as DefinitionSetData;
    expect(before.itemDefinitions.some((i) => i.key === "club_day")).toBe(false);
    const defs = (await api.applyPreset({ preset: "junior_high" })) as DefinitionSetData;
    expect(defs.itemDefinitions.some((i) => i.key === "club_day")).toBe(true);
    expect(defs.targetGroups.some((g) => g.key === "club")).toBe(true);
    expect(defs.itemDefinitions.some((i) => i.key === "club_activity")).toBe(true);
    // A transposed view over the preset's per-club item, saved
    // as a view definition — no code, no schema change.
    await api.upsertViewDefinition({
      id: "view-club-week",
      name: "部活動表（週）",
      layout: "transposed",
      audience: "staff",
      periodScope: "week",
      columns: [
        {
          id: "view-club-week-club",
          viewDefinitionId: "view-club-week",
          sourceKind: "daily_item",
          itemDefinitionId: "item-club-activity",
          dutyDefinitionId: null,
          targetGroupId: "tg-club",
          groupSameValues: true,
          widthHint: null,
          sort: 1,
        },
      ],
    });
    // The L1 month view carrying the same club column, defined
    // the same way — the two tables are two readings of it.
    await api.upsertViewDefinition({
      id: "view-month-club",
      name: "職員用月表（部活）",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [
        {
          id: "view-month-club-events",
          viewDefinitionId: "view-month-club",
          sourceKind: "event_category",
          itemDefinitionId: null,
          dutyDefinitionId: null,
          targetGroupId: null,
          groupSameValues: true,
          widthHint: null,
          sort: 1,
        },
        {
          id: "view-month-club-club",
          viewDefinitionId: "view-month-club",
          sourceKind: "daily_item",
          itemDefinitionId: "item-club-activity",
          dutyDefinitionId: null,
          targetGroupId: null,
          groupSameValues: true,
          widthHint: null,
          sort: 2,
        },
      ],
    });
    render(<App api={api} initialAnchor="2026-11-16" />);
    await screen.findByText("開発用小学校");
    fireEvent.change(screen.getByLabelText("ビュー"), { target: { value: "view-club-week" } });
    // One week of columns, one row per club of the preset school.
    await waitFor(() =>
      expect(document.querySelectorAll(".transposed-table thead th")).toHaveLength(8),
    );
    expect(rowOf("野球部")).toBeInTheDocument();
    expect(cell("2026-11-16", "tgt-club-baseball")).toHaveTextContent("練");

    // Input in the transposed table…
    fireEvent.click(cell("2026-11-16", "tgt-club-baseball"));
    const select = await screen.findByLabelText("部活動（部別）（野球部）");
    fireEvent.change(select, { target: { value: "tournament" } });
    // The cell stays in input form while it is the active one,
    // so the saved choice reads off the select's value — the
    // option labels alone would contain 大 either way.
    await waitFor(() => {
      expect(screen.getByLabelText("部活動（部別）（野球部）")).toHaveValue("tournament");
    });

    // …is the same datum the L1 month table groups into its
    // club column: data is one, the tables are two readings.
    fireEvent.change(screen.getByLabelText("ビュー"), { target: { value: "view-month-club" } });
    const dayRow = await waitFor(() => {
      const row = document.querySelector('tbody tr[data-date="2026-11-16"]');
      if (!row) throw new Error("month row not yet rendered");
      return row as HTMLElement;
    });
    expect(dayRow).toHaveTextContent("野球部 大");
  });
});

describe("the staff screen with a transposed view", () => {
  it("offers no publishing: the publish panel belongs to the rows layouts", async () => {
    const api = createDevApi();
    render(<App api={api} initialAnchor="2026-11-16" />);
    await screen.findByText("開発用小学校");
    fireEvent.change(screen.getByLabelText("ビュー"), { target: { value: "view-club-staff" } });
    await waitFor(() =>
      expect(document.querySelectorAll(".transposed-table thead th")).toHaveLength(31),
    );
    expect(screen.queryByRole("button", { name: "発行・印刷" })).not.toBeInTheDocument();
  });
});

describe("the public screen with a transposed view", () => {
  it("renders the club table read-only: values visible, no way to write", async () => {
    const view: ViewDefinitionData = { ...clubView, audience: "guardian" };
    const boot: PublicBootstrapData = {
      school: { id: "school-1", name: "テスト中学校" },
      view,
      itemDefinitions: makeBootstrap().itemDefinitions,
      targetGroups: makeBootstrap().targetGroups,
      grades: GRADES,
      holidays: [],
    };
    const range = makeRange(view, {
      values: [
        {
          date: "2026-11-16",
          itemId: "item-club-activity",
          targetId: "tgt-club-brass",
          optionCode: "meeting",
        },
      ],
    });
    const api: PublicApi = {
      getPublicBootstrap: async () => structuredClone(boot),
      getPublicRange: async () => ({ ...structuredClone(range), latestPublication: null }),
    };
    render(<PublicApp api={api} />);
    expect(await screen.findByText("吹奏楽部")).toBeInTheDocument();
    expect(cell("2026-11-16", "tgt-club-brass")).toHaveTextContent("ミ");
    expect(document.querySelectorAll(".transposed-table select")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "発行・印刷" })).not.toBeInTheDocument();
  });
});
