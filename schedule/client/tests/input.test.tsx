import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { datesInRange } from "@school-manage/calendar-types";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ApiError, ForbiddenError, type ScheduleApi } from "../src/api";
import type { BootstrapData, DailyValueData, RangeData, RangeDayData } from "../src/types";

afterEach(cleanup);

// Cell input tests (Issue #35): typing in a selected cell and
// pressing Enter saves one entry and the cell stays ready for the
// next; a leave entry's typed name becomes the holder through the
// staff roster; daily values follow their value type; a failed
// save keeps the typed text. The API is a fake with the same
// in-memory semantics as the development adapter: a write is what
// the next getRange shows.

const STAFF = [
  { id: "staff-1", name: "田中一郎" },
  { id: "staff-2", name: "佐藤花" },
];
const GRADES = [
  { id: "grade-1", name: "1年" },
  { id: "grade-2", name: "2年" },
];
const DATE = "2026-11-16"; // a Monday

function makeBootstrap(role: string, teacherId: string | null): BootstrapData {
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
  const template = (
    key: string,
    name: string,
    subjectKind: "event" | "absence",
    personLabel: string,
    displaySource: "title" | "person" | "person_title",
    sort: number,
  ): BootstrapData["kindTemplates"][number] => ({
    id: `tpl-${key}`,
    key,
    name,
    subjectKind,
    kindCode: key,
    personLabel,
    displaySource,
    steps: [{ kind: "person" }, { kind: "time" }],
    itemDefinitionIds: [],
    sort,
  });
  return {
    school: { id: "school-1", name: "テスト学校" },
    userId: "user-1",
    teacherId,
    role,
    permissions: role === "Viewer" ? ["view.read"] : ["view.read", "daily.write", "event.write"],
    views: [
      {
        id: "view-month",
        name: "職員用月表",
        layout: "month_rows",
        layoutParams: null,
        audience: "staff",
        periodScope: "month",
        printSettings: null,
        columns: [
          {
            id: "col-events",
            viewDefinitionId: "view-month",
            sourceKind: "event_category",
            itemDefinitionId: null,
            dutyDefinitionId: null,
            targetGroupId: null,
            groupSameValues: true,
            widthHint: null,
            sort: 1,
          },
          {
            id: "col-lunch",
            viewDefinitionId: "view-month",
            sourceKind: "daily_item",
            itemDefinitionId: "item-lunch",
            dutyDefinitionId: null,
            targetGroupId: null,
            groupSameValues: true,
            widthHint: null,
            sort: 2,
          },
          {
            id: "col-dismissal",
            viewDefinitionId: "view-month",
            sourceKind: "daily_item",
            itemDefinitionId: "item-dismissal",
            dutyDefinitionId: null,
            targetGroupId: null,
            groupSameValues: true,
            widthHint: null,
            sort: 3,
          },
        ],
      },
    ],
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
      template("event", "行事", "event", "担当者", "title", 1),
      template("business_trip", "出張", "absence", "出張者", "person_title", 2),
      template("deadline", "〆切", "event", "担当者", "title", 3),
      template("leave", "休暇", "absence", "取得者", "person", 4),
    ],
    masters: { staff: STAFF, grades: GRADES, dayPatterns: [] },
  };
}

interface FakeState {
  events: Record<string, unknown>[];
  absences: Record<string, unknown>[];
  daily: Map<string, DailyValueData[]>;
}

function dailyValue(partial: Partial<DailyValueData> & { date: string }): DailyValueData {
  return {
    id: `dv-${Math.random().toString(36).slice(2)}`,
    itemDefinitionId: "item-lunch",
    targetId: null,
    targetRef: null,
    slot: "all_day",
    valueText: null,
    valueTime: null,
    valueTimeEnd: null,
    valueNumber: null,
    valueBoolean: null,
    valueOptionId: null,
    valuePersonId: null,
    ...partial,
  };
}

function makeFakeApi(bootstrap: BootstrapData) {
  const state: FakeState = {
    events: [
      {
        id: "ev-existing",
        kind: "event",
        kindLabel: null,
        title: "職員会議",
        datePrecision: "day",
        startsOn: DATE,
        endsOn: DATE,
        time: null,
        locationId: null,
        locationText: null,
        description: null,
        certainty: "confirmed",
        visibility: "staff_only",
        targets: [],
        impacts: [],
        assignees: [],
        revision: 3,
      },
    ],
    absences: [],
    daily: new Map([[DATE, [dailyValue({ date: DATE, valueOptionId: "opt-lunch-no" })]]]),
  };
  const calls = {
    createEvent: [] as { event: Record<string, unknown> }[],
    updateEvent: [] as { id: string; revision: number; event: Record<string, unknown> }[],
    deleteEvent: [] as { id: string; revision: number }[],
    createAbsence: [] as { absence: Record<string, unknown> }[],
    updateAbsence: [] as unknown[],
    deleteAbsence: [] as unknown[],
    setDailyValue: [] as {
      date: string;
      itemDefinitionId: string;
      target?: unknown;
      value: unknown;
    }[],
    deleteDailyValue: [] as unknown[],
  };
  const control = {
    failCreateEvent: false,
    failSetDailyValue: null as Error | null,
  };
  const itemsById = new Map(bootstrap.itemDefinitions.map((i) => [i.id, i]));
  const api: ScheduleApi = {
    getBootstrap: async () => bootstrap,
    getRange: async (input): Promise<RangeData> => {
      const days: RangeDayData[] = datesInRange(input.from, input.to).map((date) => ({
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
        events: state.events.filter(
          (e) => (e["startsOn"] as string) <= date && date <= (e["endsOn"] as string),
        ),
        absences: state.absences.filter(
          (a) => (a["fromDate"] as string) <= date && date <= (a["toDate"] as string),
        ),
        dailyValues: state.daily.get(date) ?? [],
        dutyAssignments: [],
      }));
      return {
        view: bootstrap.views[0] as RangeData["view"],
        from: input.from,
        to: input.to,
        days,
        undecided: [],
        eventValues: [],
        conflicts: [],
      };
    },
    createEvent: async (input) => {
      calls.createEvent.push(input);
      if (control.failCreateEvent) {
        throw new ApiError(500, "サーバーでエラーが起きました");
      }
      const record = { ...input.event, revision: 1 };
      state.events.push(record);
      return { record, values: [] };
    },
    updateEvent: async (input) => {
      calls.updateEvent.push(input);
      const index = state.events.findIndex((e) => e["id"] === input.id);
      const record = { ...input.event, id: input.id, revision: input.revision + 1 };
      if (index >= 0) state.events[index] = record;
      return { record, values: null };
    },
    deleteEvent: async (input) => {
      calls.deleteEvent.push(input);
      state.events = state.events.filter((e) => e["id"] !== input.id);
      return { deleted: true };
    },
    createAbsence: async (input) => {
      calls.createAbsence.push(input);
      const record = {
        ...input.absence,
        revision: 1,
        createdBy: "user-1",
        confirmedBy: null,
        confirmedAt: null,
      };
      state.absences.push(record);
      return { record, values: [] };
    },
    updateAbsence: async (input) => {
      calls.updateAbsence.push(input);
      return { record: input.absence, values: null };
    },
    deleteAbsence: async (input) => {
      calls.deleteAbsence.push(input);
      return { deleted: true };
    },
    setDailyValue: async (input) => {
      calls.setDailyValue.push(input);
      if (control.failSetDailyValue) throw control.failSetDailyValue;
      const itemDef = itemsById.get(input.itemDefinitionId);
      const target = input.target as { id: string } | null | undefined;
      const columns: Partial<DailyValueData> =
        itemDef?.valueType === "symbol"
          ? { valueOptionId: itemDef.options.find((o) => o.code === input.value)?.id ?? null }
          : itemDef?.valueType === "time"
            ? { valueTime: input.value as string }
            : {};
      const values = state.daily.get(input.date) ?? [];
      const targetId = target?.id ?? null;
      const existing = values.find(
        (v) =>
          v.itemDefinitionId === input.itemDefinitionId &&
          (v.targetId ?? v.targetRef?.id ?? null) === targetId,
      );
      if (existing) {
        Object.assign(existing, { valueOptionId: null, valueTime: null, ...columns });
        return existing;
      }
      const stored = dailyValue({
        date: input.date,
        itemDefinitionId: input.itemDefinitionId,
        targetRef: target ? { axis: "grade", id: target.id } : null,
        ...columns,
      });
      values.push(stored);
      state.daily.set(input.date, values);
      return stored;
    },
    deleteDailyValue: async (input) => {
      calls.deleteDailyValue.push(input);
      return { deleted: true };
    },
  };
  return { api, calls, control, state };
}

function cell(date: string, columnIndex: number): HTMLElement {
  const row = document.querySelector(`tr[data-date="${date}"]`);
  if (!row) throw new Error(`row not found: ${date}`);
  const td = row.querySelectorAll("td")[columnIndex];
  if (!td) throw new Error(`cell not found: ${date} col ${columnIndex}`);
  return td as HTMLElement;
}

async function renderApp(role = "Admin", teacherId: string | null = "staff-9") {
  const bootstrap = makeBootstrap(role, teacherId);
  const fake = makeFakeApi(bootstrap);
  render(<App api={fake.api} initialAnchor={DATE} />);
  await screen.findByText("テスト学校");
  await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(30));
  return fake;
}

describe("entry cells (Issue #35)", () => {
  it("typing and Enter saves one event, and a second follows in the same cell", async () => {
    const { calls } = await renderApp();
    const eventsCell = cell(DATE, 0);
    fireEvent.click(eventsCell);
    const input = within(eventsCell).getByLabelText(/行事の入力/);
    fireEvent.change(input, { target: { value: "運動会" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.createEvent).toHaveLength(1));
    expect(calls.createEvent[0]?.event).toMatchObject({
      title: "運動会",
      kind: "event",
      startsOn: DATE,
      endsOn: DATE,
    });
    // The saved entry shows, and the same cell takes the next one.
    await waitFor(() => expect(within(cell(DATE, 0)).getByText("運動会")).toBeInTheDocument());
    const next = within(cell(DATE, 0)).getByLabelText(/行事の入力/);
    fireEvent.change(next, { target: { value: "避難訓練" } });
    fireEvent.keyDown(next, { key: "Enter" });
    await waitFor(() => expect(calls.createEvent).toHaveLength(2));
    await waitFor(() => expect(within(cell(DATE, 0)).getByText("避難訓練")).toBeInTheDocument());
    expect(within(cell(DATE, 0)).getByText("運動会")).toBeInTheDocument();
  });

  it("in a leave entry, the typed name becomes the holder", async () => {
    const { calls } = await renderApp();
    const eventsCell = cell(DATE, 0);
    fireEvent.click(eventsCell);
    fireEvent.click(within(eventsCell).getByRole("button", { name: "休暇" }));
    const input = within(eventsCell).getByLabelText(/行事の入力/);
    fireEvent.change(input, { target: { value: "田中一郎" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.createAbsence).toHaveLength(1));
    expect(calls.createAbsence[0]?.absence).toMatchObject({
      staffId: "staff-1",
      kind: "leave",
      fromDate: DATE,
      toDate: DATE,
    });
    expect(calls.createEvent).toHaveLength(0);
    await waitFor(() => expect(within(cell(DATE, 0)).getByText("田中一郎")).toBeInTheDocument());
  });

  it("a name matching nobody is kept as free text, not dropped", async () => {
    const { calls } = await renderApp();
    const eventsCell = cell(DATE, 0);
    fireEvent.click(eventsCell);
    fireEvent.click(within(eventsCell).getByRole("button", { name: "休暇" }));
    const input = within(eventsCell).getByLabelText(/行事の入力/);
    fireEvent.change(input, { target: { value: "外部講師" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.createEvent).toHaveLength(1));
    expect(calls.createAbsence).toHaveLength(0);
    expect(calls.createEvent[0]?.event).toMatchObject({
      title: "外部講師（休暇）",
      assignees: [{ kind: "free_text", name: "外部講師", role: "取得者" }],
    });
    await waitFor(() =>
      expect(within(cell(DATE, 0)).getByText("外部講師（休暇）")).toBeInTheDocument(),
    );
  });

  it("an existing entry can be re-edited and deleted on its own", async () => {
    const { calls } = await renderApp();
    const eventsCell = cell(DATE, 0);
    fireEvent.click(within(eventsCell).getByRole("button", { name: "職員会議を編集" }));
    const edit = within(eventsCell).getByLabelText("予定の再編集");
    expect(edit).toHaveValue("職員会議");
    fireEvent.change(edit, { target: { value: "朝会" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    await waitFor(() => expect(calls.updateEvent).toHaveLength(1));
    expect(calls.updateEvent[0]).toMatchObject({ id: "ev-existing", revision: 3 });
    expect(calls.updateEvent[0]?.event).toMatchObject({ title: "朝会" });
    await waitFor(() => expect(within(cell(DATE, 0)).getByText("朝会")).toBeInTheDocument());

    fireEvent.click(within(cell(DATE, 0)).getByRole("button", { name: "朝会を削除" }));
    await waitFor(() => expect(calls.deleteEvent).toHaveLength(1));
    expect(calls.deleteEvent[0]).toEqual({ id: "ev-existing", revision: 4 });
    await waitFor(() => expect(within(cell(DATE, 0)).queryByText("朝会")).not.toBeInTheDocument());
  });

  it("a failed save keeps the typed text and says so in the cell", async () => {
    const { calls, control } = await renderApp();
    control.failCreateEvent = true;
    const eventsCell = cell(DATE, 0);
    fireEvent.click(eventsCell);
    const input = within(eventsCell).getByLabelText(/行事の入力/);
    fireEvent.change(input, { target: { value: "運動会" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.createEvent).toHaveLength(1));
    await waitFor(() =>
      expect(within(cell(DATE, 0)).getByRole("alert")).toHaveTextContent(/保存できませんでした/),
    );
    expect(within(cell(DATE, 0)).getByLabelText(/行事の入力/)).toHaveValue("運動会");
    expect(within(cell(DATE, 0)).queryByText("運動会")).not.toBeInTheDocument();
  });
});

describe("daily-value cells (Issue #35)", () => {
  it("a symbol column takes a choice", async () => {
    const { calls } = await renderApp();
    const lunchCell = cell(DATE, 1);
    expect(lunchCell).toHaveTextContent("×");
    fireEvent.click(lunchCell);
    const select = within(lunchCell).getByLabelText("給食");
    fireEvent.change(select, { target: { value: "yes" } });
    await waitFor(() => expect(calls.setDailyValue).toHaveLength(1));
    expect(calls.setDailyValue[0]).toMatchObject({
      date: DATE,
      itemDefinitionId: "item-lunch",
      value: "yes",
    });
    await waitFor(() => expect(within(cell(DATE, 1)).getByLabelText("給食")).toHaveValue("yes"));
  });

  it("a time column takes a typed time per target", async () => {
    const { calls } = await renderApp();
    const dismissalCell = cell(DATE, 2);
    fireEvent.click(dismissalCell);
    const input = within(dismissalCell).getByLabelText("下校（1年）");
    fireEvent.change(input, { target: { value: "15:20" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.setDailyValue).toHaveLength(1));
    expect(calls.setDailyValue[0]).toMatchObject({
      date: DATE,
      itemDefinitionId: "item-dismissal",
      value: "15:20",
      target: { axis: "grade", id: "grade-1" },
    });
  });

  it("a 403 on a daily write puts the choice back and says so", async () => {
    const { calls, control } = await renderApp();
    control.failSetDailyValue = new ForbiddenError();
    const lunchCell = cell(DATE, 1);
    fireEvent.click(lunchCell);
    const select = within(lunchCell).getByLabelText("給食");
    expect(select).toHaveValue("no");
    fireEvent.change(select, { target: { value: "yes" } });
    await waitFor(() => expect(calls.setDailyValue).toHaveLength(1));
    await waitFor(() =>
      expect(within(cell(DATE, 1)).getByRole("alert")).toHaveTextContent(/権限がありません/),
    );
    expect(within(cell(DATE, 1)).getByLabelText("給食")).toHaveValue("no");
  });
});

describe("a Viewer's screen (Issue #35)", () => {
  it("starts no daily input, and only their own absence entries", async () => {
    const { calls } = await renderApp("Viewer", "staff-1");
    // Daily-value cells stay read-only text.
    const lunchCell = cell(DATE, 1);
    fireEvent.click(lunchCell);
    expect(within(lunchCell).queryByLabelText("給食")).not.toBeInTheDocument();

    // The entry cell offers only the absence kinds.
    const eventsCell = cell(DATE, 0);
    fireEvent.click(eventsCell);
    expect(within(eventsCell).queryByRole("button", { name: "行事" })).not.toBeInTheDocument();
    expect(within(eventsCell).queryByRole("button", { name: "〆切" })).not.toBeInTheDocument();
    // Their own name is already in the input; saving makes their
    // leave, as tentative.
    fireEvent.click(within(eventsCell).getByRole("button", { name: "休暇" }));
    const input = within(eventsCell).getByLabelText(/行事の入力/);
    expect(input).toHaveValue("田中一郎");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.createAbsence).toHaveLength(1));
    expect(calls.createAbsence[0]?.absence).toMatchObject({
      staffId: "staff-1",
      kind: "leave",
      certainty: "tentative",
    });
    expect(calls.createEvent).toHaveLength(0);
    // Other people's entries carry no controls.
    expect(
      within(cell(DATE, 0)).queryByRole("button", { name: "職員会議を削除" }),
    ).not.toBeInTheDocument();
  });
});

describe("the development adapter's writes (Issue #35)", () => {
  it("a saved event, absence and daily value are what the next range shows", async () => {
    const { createDevApi } = await import("../src/devAdapter");
    const api = createDevApi();
    await api.createEvent({
      event: {
        id: "ev-new",
        kind: "event",
        kindLabel: null,
        title: "運動会",
        datePrecision: "day",
        startsOn: DATE,
        endsOn: DATE,
        time: null,
        locationId: null,
        locationText: null,
        description: null,
        certainty: "confirmed",
        visibility: "staff_only",
        targets: [],
        impacts: [],
        assignees: [],
      },
    });
    await api.createAbsence({
      absence: {
        id: "abs-new",
        staffId: "teacher-3",
        fromDate: DATE,
        toDate: DATE,
        time: { kind: "all_day" },
        kind: "leave",
        certainty: "confirmed",
        purpose: null,
        note: null,
        subdivisionKey: null,
      },
    });
    await api.setDailyValue({
      date: DATE,
      itemDefinitionId: "item-dismissal",
      target: { axis: "grade", id: "grade-1" },
      value: "16:00",
    });
    const range = await api.getRange({ from: DATE, to: DATE, viewId: "view-month-staff" });
    const day = range.days[0] as RangeDayData;
    expect(day.events.map((e) => e["title"])).toContain("運動会");
    expect(day.absences.map((a) => a["staffId"])).toContain("teacher-3");
    expect(
      day.dailyValues.find(
        (v) => v.itemDefinitionId === "item-dismissal" && v.targetRef?.id === "grade-1",
      )?.valueTime,
    ).toBe("16:00");
    // The fixture's own leave is there too, holder-led.
    const nov13 = await api.getRange({
      from: "2026-11-13",
      to: "2026-11-13",
      viewId: "view-month-staff",
    });
    expect(nov13.days[0]?.absences).toHaveLength(1);
    expect(nov13.days[0]?.absences[0]).toMatchObject({ kind: "leave", staffId: "teacher-2" });
  });
});
