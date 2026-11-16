import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { datesInRange } from "@school-manage/calendar-types";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ClockPicker } from "../src/ClockPicker";
import type { ScheduleApi } from "../src/api";
import type { BootstrapData, EventValueData, RangeData, RangeDayData } from "../src/types";

afterEach(cleanup);

// The quick-entry popover (Issue #36; DESIGN schedule 6.5): the
// Enter that lands an entry opens it beside the cell, its steps
// follow the kind template, and every step saves the moment it is
// confirmed — so closing the popover halfway keeps what was
// confirmed. The API is a fake with the development adapter's
// in-memory semantics: a write is what the next getRange shows.

const STAFF = [
  { id: "staff-1", name: "田中一郎" },
  { id: "staff-2", name: "佐藤花" },
];
const DATE = "2026-11-16"; // a Monday

function makeBootstrap(inputOpener: "popover" | "modal" = "popover"): BootstrapData {
  const item = (
    id: string,
    key: string,
    name: string,
    valueType: string,
    sort: number,
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
  });
  const template = (
    key: string,
    name: string,
    subjectKind: "event" | "absence",
    personLabel: string,
    displaySource: BootstrapData["kindTemplates"][number]["displaySource"],
    steps: BootstrapData["kindTemplates"][number]["steps"],
    sort: number,
  ): BootstrapData["kindTemplates"][number] => ({
    id: `tpl-${key}`,
    key,
    name,
    subjectKind,
    kindCode: key,
    personLabel,
    displaySource,
    steps,
    itemDefinitionIds: [],
    sort,
  });
  const column = (
    id: string,
    sourceKind: "event_category" | "daily_item",
    itemDefinitionId: string | null,
    sort: number,
  ): BootstrapData["views"][number]["columns"][number] => ({
    id,
    viewDefinitionId: "view-month",
    sourceKind,
    itemDefinitionId,
    dutyDefinitionId: null,
    targetGroupId: null,
    groupSameValues: true,
    widthHint: null,
    sort,
  });
  return {
    school: { id: "school-1", name: "テスト学校" },
    userId: "user-1",
    teacherId: "staff-1",
    role: "Admin",
    permissions: ["view.read", "daily.write", "event.write"],
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
          column("col-events", "event_category", null, 1),
          column("col-movement", "daily_item", "item-staff-movement", 2),
        ],
      },
    ],
    itemDefinitions: [
      item("item-staff-movement", "staff_movement", "職員動静", "event_list", 1),
      item("item-note", "note", "提出物メモ", "text", 2),
    ],
    targetGroups: [],
    kindTemplates: [
      template(
        "event",
        "行事",
        "event",
        "担当者",
        "title",
        [{ kind: "person" }, { kind: "location" }, { kind: "time" }],
        1,
      ),
      template(
        "business_trip",
        "出張",
        "absence",
        "出張者",
        "person_title",
        [{ kind: "person" }, { kind: "location" }, { kind: "time" }],
        2,
      ),
      template(
        "deadline",
        "〆切",
        "event",
        "担当者",
        "title",
        [{ kind: "person" }, { kind: "item", itemDefinitionId: "item-note" }, { kind: "time" }],
        3,
      ),
      template(
        "leave",
        "休暇",
        "absence",
        "取得者",
        "person",
        [{ kind: "person" }, { kind: "subdivision" }, { kind: "time" }],
        4,
      ),
    ],
    dutyDefinitions: [],
    locations: [
      { id: "loc-gym", name: "体育館", kind: null, sort: 1, isActive: true },
      { id: "loc-music", name: "音楽室", kind: null, sort: 2, isActive: true },
    ],
    absenceSubdivisions: [
      { id: "subdiv-annual", code: "leave", key: "annual", label: "年休" },
      { id: "subdiv-sick", code: "leave", key: "sick", label: "病休" },
    ],
    inputOpener,
    masters: { staff: STAFF, grades: [], dayPatterns: [] },
  };
}

interface FakeState {
  events: Record<string, unknown>[];
  absences: Record<string, unknown>[];
  eventValues: Map<string, EventValueData[]>;
}

function makeFakeApi(bootstrap: BootstrapData) {
  const state: FakeState = { events: [], absences: [], eventValues: new Map() };
  const calls = {
    createEvent: [] as { event: Record<string, unknown> }[],
    updateEvent: [] as { id: string; revision: number; event: Record<string, unknown> }[],
    createAbsence: [] as { absence: Record<string, unknown> }[],
    updateAbsence: [] as { id: string; revision: number; absence: Record<string, unknown> }[],
    setEventValues: [] as {
      subjectKind: "event" | "absence";
      subjectId: string;
      values: { itemDefinitionId: string; target?: unknown; value: unknown }[];
    }[],
  };
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
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
        dailyValues: [],
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
    deleteEvent: unused,
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
      const index = state.absences.findIndex((a) => a["id"] === input.id);
      const record = {
        ...(index >= 0 ? state.absences[index] : {}),
        ...input.absence,
        id: input.id,
        revision: input.revision + 1,
      };
      if (index >= 0) state.absences[index] = record;
      return { record, values: null };
    },
    deleteAbsence: unused,
    setDailyValue: unused,
    deleteDailyValue: unused,
    getEventValues: async (input) => state.eventValues.get(input.subjectId) ?? [],
    setEventValues: async (input) => {
      calls.setEventValues.push(input);
      const rows: EventValueData[] = input.values.map((entry, i) => ({
        id: `evv-${input.subjectId}-${i}`,
        itemDefinitionId: entry.itemDefinitionId,
        targetId: null,
        targetRef: null,
        valueText: typeof entry.value === "string" ? entry.value : null,
        valueTime: null,
        valueTimeEnd: null,
        valueNumber: null,
        valueBoolean: null,
        valueOptionId: null,
        valuePersonId: null,
      }));
      state.eventValues.set(input.subjectId, rows);
      return rows;
    },
    previewRotation: unused,
    applyRotation: unused,
    proposeDutyChange: unused,
    applyDutyChange: unused,
    declineDutyChange: unused,
    getDutyChanges: unused,
    getDutyConflicts: unused,
    waiveConflict: unused,
    getDutyChangeCandidates: unused,
    // The settings screens and the confirmation queue (Issue #39)
    // are not exercised by these tests.
    getDefinitions: unused,
    upsertItemDefinition: unused,
    deleteItemDefinition: unused,
    upsertTargetGroup: unused,
    deleteTargetGroup: unused,
    upsertTarget: unused,
    deleteTarget: unused,
    upsertLocation: unused,
    deleteLocation: unused,
    saveSettings: unused,
    applyPreset: unused,
    upsertViewDefinition: unused,
    deleteViewDefinition: unused,
    upsertDutyDefinition: unused,
    deleteDutyDefinition: unused,
    upsertKindTemplate: unused,
    deleteKindTemplate: unused,
    applyDefaultKindTemplates: unused,
    getMasters: unused,
    createMaster: unused,
    updateMaster: unused,
    deleteMaster: unused,
    getPendingAbsences: unused,
    confirmAbsence: unused,
    getPendingEvents: unused,
    confirmEvent: unused,
    createPublication: unused,
    getPublications: unused,
    getPublication: unused,
  };
  return { api, calls, state };
}

function cell(date: string, columnIndex: number): HTMLElement {
  const row = document.querySelector(`tr[data-date="${date}"]`);
  if (!row) throw new Error(`row not found: ${date}`);
  const td = row.querySelectorAll("td")[columnIndex];
  if (!td) throw new Error(`cell not found: ${date} col ${columnIndex}`);
  return td as HTMLElement;
}

async function renderApp(inputOpener: "popover" | "modal" = "popover") {
  const bootstrap = makeBootstrap(inputOpener);
  const fake = makeFakeApi(bootstrap);
  render(<App api={fake.api} initialAnchor={DATE} />);
  await screen.findByText("テスト学校");
  await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(30));
  return fake;
}

/** Types a title into the events cell and lands it with Enter;
 *  returns the opened popover. */
async function createEventWithPopover(title: string) {
  const eventsCell = cell(DATE, 0);
  fireEvent.click(eventsCell);
  const input = within(eventsCell).getByLabelText(/行事の入力/);
  fireEvent.change(input, { target: { value: title } });
  fireEvent.keyDown(input, { key: "Enter" });
  return screen.findByRole("dialog", { name: `${title}のクイック入力` });
}

describe("quick-entry popover (Issue #36)", () => {
  it("saves each step as it is confirmed, and closing midway keeps what was saved", async () => {
    const { calls, state } = await renderApp();
    const dialog = await createEventWithPopover("運動会");

    // The person step: Ctrl+Enter adds the person and stays.
    const personInput = within(dialog).getByLabelText("担当者");
    fireEvent.change(personInput, { target: { value: "田中" } });
    fireEvent.keyDown(personInput, { key: "Enter", ctrlKey: true });
    expect(within(dialog).getByText("田中一郎")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("担当者")).toBeInTheDocument();
    expect(calls.updateEvent).toHaveLength(0);

    // A plain Enter confirms the step: the assignees save at
    // once, and the popover moves to the location step.
    fireEvent.keyDown(personInput, { key: "Enter" });
    await waitFor(() => expect(calls.updateEvent).toHaveLength(1));
    expect(calls.updateEvent[0]?.event["assignees"]).toEqual([
      { kind: "staff", staffId: "staff-1", role: "担当者" },
    ]);
    const locationInput = await within(dialog).findByLabelText("場所");

    // The location step: Enter on the highlighted suggestion
    // chooses the registered place and saves it.
    fireEvent.change(locationInput, { target: { value: "体育" } });
    fireEvent.keyDown(locationInput, { key: "Enter" });
    await waitFor(() => expect(calls.updateEvent).toHaveLength(2));
    expect(calls.updateEvent[1]?.event).toMatchObject({
      locationId: "loc-gym",
      locationText: null,
    });
    await within(dialog).findByRole("button", { name: "時刻指定" });

    // Closing midway (Esc) keeps everything confirmed so far.
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const saved = state.events.find((e) => e["title"] === "運動会");
    expect(saved?.["assignees"]).toEqual([{ kind: "staff", staffId: "staff-1", role: "担当者" }]);
    expect(saved?.["locationId"]).toBe("loc-gym");
    expect(within(cell(DATE, 0)).getByText("運動会")).toBeInTheDocument();
  });

  it("Ctrl+Enter adds people one after another on the person step", async () => {
    const { calls } = await renderApp();
    const dialog = await createEventWithPopover("避難訓練");
    const personInput = within(dialog).getByLabelText("担当者");

    fireEvent.change(personInput, { target: { value: "佐藤" } });
    fireEvent.keyDown(personInput, { key: "Enter", ctrlKey: true });
    fireEvent.change(personInput, { target: { value: "田中" } });
    fireEvent.keyDown(personInput, { key: "Enter", ctrlKey: true });

    // Both names are held on the step, and nothing has saved yet.
    expect(within(dialog).getByText("佐藤花")).toBeInTheDocument();
    expect(within(dialog).getByText("田中一郎")).toBeInTheDocument();
    expect(calls.updateEvent).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "次へ" }));
    await waitFor(() => expect(calls.updateEvent).toHaveLength(1));
    expect(calls.updateEvent[0]?.event["assignees"]).toEqual([
      { kind: "staff", staffId: "staff-2", role: "担当者" },
      { kind: "staff", staffId: "staff-1", role: "担当者" },
    ]);
  });

  it("a leave has no location step, and its subdivision step saves the classification", async () => {
    const { calls } = await renderApp();
    const movementCell = cell(DATE, 1);
    fireEvent.click(movementCell);
    fireEvent.click(within(movementCell).getByRole("button", { name: "休暇" }));
    const input = within(movementCell).getByLabelText(/職員動静の入力/);
    fireEvent.change(input, { target: { value: "佐藤花" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.createAbsence).toHaveLength(1));

    const dialog = await screen.findByRole("dialog", { name: "佐藤花のクイック入力" });
    // The leave's steps are the holder, the classification and
    // the time band — no location step anywhere (6.5).
    expect(within(dialog).getByRole("button", { name: /取得者/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /休暇分類/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /時間帯/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /場所/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("場所")).not.toBeInTheDocument();

    // Jumping to the classification step by its heading and
    // choosing 年休 saves it at once and moves on.
    fireEvent.click(within(dialog).getByRole("button", { name: /休暇分類/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "年休" }));
    await waitFor(() =>
      expect(calls.updateAbsence.some((c) => c.absence["subdivisionKey"] === "annual")).toBe(true),
    );
    expect(within(dialog).getByRole("button", { name: /時間帯/ })).toHaveAttribute(
      "aria-current",
      "step",
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The cell line shows the school's word for the classification.
    expect(within(cell(DATE, 1)).getByText("佐藤花（年休）")).toBeInTheDocument();
  });

  it("a bound item step saves its value through setEventValues", async () => {
    const { calls, state } = await renderApp();
    const eventsCell = cell(DATE, 0);
    fireEvent.click(eventsCell);
    fireEvent.click(within(eventsCell).getByRole("button", { name: "〆切" }));
    const input = within(eventsCell).getByLabelText(/行事の入力/);
    fireEvent.change(input, { target: { value: "作品票提出" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", { name: "作品票提出のクイック入力" });

    // The person step has nothing to save; 次へ moves past it.
    fireEvent.click(within(dialog).getByRole("button", { name: "次へ" }));
    const itemInput = await within(dialog).findByLabelText("提出物メモ");
    await waitFor(() => expect(itemInput).not.toBeDisabled());
    fireEvent.change(itemInput, { target: { value: "A4両面" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(calls.setEventValues).toHaveLength(1));
    expect(calls.setEventValues[0]?.values).toEqual([
      { itemDefinitionId: "item-note", target: null, value: "A4両面" },
    ]);
    const created = state.events.find((e) => e["title"] === "作品票提出");
    expect(state.eventValues.get(created?.["id"] as string)?.[0]?.valueText).toBe("A4両面");
  });

  it("a school set to the modal opens the detail modal, not the popover", async () => {
    const { calls } = await renderApp("modal");
    const eventsCell = cell(DATE, 0);
    fireEvent.click(eventsCell);
    const input = within(eventsCell).getByLabelText(/行事の入力/);
    fireEvent.change(input, { target: { value: "運動会" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.createEvent).toHaveLength(1));
    // No popover (Issue #36); the detail modal opens instead
    // (Issue #37, DESIGN schedule 6.5).
    expect(screen.queryByRole("dialog", { name: /クイック入力/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "行事の詳細" })).toBeInTheDocument();
  });

  it("a provisional entry (a placeholder name) opens no popover", async () => {
    const { calls } = await renderApp();
    const movementCell = cell(DATE, 1);
    fireEvent.click(movementCell);
    const input = within(movementCell).getByLabelText(/職員動静の入力/);
    fireEvent.change(input, { target: { value: "生徒指導担当" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.createEvent).toHaveLength(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(cell(DATE, 1)).getByText("生徒指導担当")).toBeInTheDocument(),
    );
  });

  /** Jumps to the time step by its heading and chooses 時刻指定;
   *  returns the start time's direct-entry field. */
  async function openClockStep(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole("button", { name: "3. 時間" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "時刻指定" }));
    return within(dialog).findByLabelText("開始（直接入力）");
  }

  const clockSave = (calls: ReturnType<typeof makeFakeApi>["calls"]) =>
    calls.updateEvent.find(
      (c) => (c.event["time"] as { kind?: string } | undefined)?.kind === "clock",
    );

  it("a directly typed start time saves on a single Enter", async () => {
    const { calls } = await renderApp();
    const dialog = await createEventWithPopover("運動会");
    const startInput = await openClockStep(dialog);
    fireEvent.change(startInput, { target: { value: "09:30" } });
    fireEvent.keyDown(startInput, { key: "Enter" });
    // One Enter is enough: the confirm saves the value the
    // keystroke itself committed, not the state queued behind it.
    await waitFor(() => expect(clockSave(calls)).toBeDefined());
    expect(clockSave(calls)?.event["time"]).toEqual({
      kind: "clock",
      startsAt: "09:30",
      endsAt: null,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(cell(DATE, 0)).getByText("09:30 運動会")).toBeInTheDocument();
  });

  it("a directly typed end time saves on a single Enter", async () => {
    const { calls } = await renderApp();
    const dialog = await createEventWithPopover("運動会");
    const startInput = await openClockStep(dialog);
    fireEvent.change(startInput, { target: { value: "09:30" } });
    fireEvent.blur(startInput);
    const endInput = within(dialog).getByLabelText("終了（直接入力）");
    fireEvent.change(endInput, { target: { value: "11:00" } });
    fireEvent.keyDown(endInput, { key: "Enter" });
    await waitFor(() => expect(clockSave(calls)).toBeDefined());
    expect(clockSave(calls)?.event["time"]).toEqual({
      kind: "clock",
      startsAt: "09:30",
      endsAt: "11:00",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("the time step holds the focus: arrows switch the kind and Enter confirms", async () => {
    const { calls } = await renderApp();
    const dialog = await createEventWithPopover("運動会");
    // From the person step an empty Enter moves on; from the
    // location step Enter takes the highlighted place, saves it,
    // and lands on the time step.
    fireEvent.keyDown(within(dialog).getByLabelText("担当者"), { key: "Enter" });
    const locationInput = await within(dialog).findByLabelText("場所");
    fireEvent.keyDown(locationInput, { key: "Enter" });
    await waitFor(() => expect(calls.updateEvent).toHaveLength(1));
    expect(calls.updateEvent[0]?.event).toMatchObject({ locationId: "loc-gym" });

    // The selected kind's chip holds the focus (6.5), so the
    // keyboard is never stranded on this step.
    const allDayChip = await within(dialog).findByRole("button", { name: "終日" });
    await waitFor(() => expect(document.activeElement).toBe(allDayChip));

    // The arrows move the selection — and the focus — across
    // the kinds; the pickers open under 時刻指定 without the
    // focus leaving the chips.
    fireEvent.keyDown(allDayChip, { key: "ArrowRight" });
    const clockChip = within(dialog).getByRole("button", { name: "時刻指定" });
    expect(clockChip).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(clockChip);
    expect(within(dialog).getByLabelText("開始（直接入力）")).toBeInTheDocument();
    fireEvent.keyDown(clockChip, { key: "ArrowLeft" });
    expect(allDayChip).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(allDayChip);

    // Enter on the chip confirms the step; the time step is the
    // last one, so the popover closes, with nothing more saved.
    fireEvent.keyDown(allDayChip, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.updateEvent).toHaveLength(1);
  });

  it("Esc closes the popover even when the keydown never reaches it", async () => {
    await renderApp();
    const dialog = await createEventWithPopover("運動会");
    expect(dialog).toBeInTheDocument();
    // The keydown is dispatched outside the popover (focus lost
    // to the page): Esc is heard at the document level too.
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("an end time earlier than the start is stopped on screen", async () => {
    const { calls } = await renderApp();
    const dialog = await createEventWithPopover("運動会");
    const startInput = await openClockStep(dialog);
    fireEvent.change(startInput, { target: { value: "10:00" } });
    fireEvent.blur(startInput);
    const endInput = within(dialog).getByLabelText("終了（直接入力）");
    fireEvent.change(endInput, { target: { value: "09:00" } });
    fireEvent.blur(endInput);
    fireEvent.click(within(dialog).getByRole("button", { name: "確定" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "終了は開始より後の時刻にしてください",
    );
    expect(clockSave(calls)).toBeUndefined();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("clock picker (Issue #36)", () => {
  it("the dial picks the hour, then the minute in 5-minute steps", () => {
    const seen: string[] = [];
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <ClockPicker
          label="開始"
          value={value}
          onChange={(v) => {
            seen.push(v);
            setValue(v);
          }}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "開始を時計盤で選ぶ" }));
    fireEvent.click(screen.getByRole("button", { name: "9時" }));
    expect(seen).toEqual(["09:00"]);
    fireEvent.click(screen.getByRole("button", { name: "30分" }));
    expect(seen).toEqual(["09:00", "09:30"]);
  });

  it("the text field commits an HH:MM entry", () => {
    const onChange = vi.fn();
    render(<ClockPicker label="開始" value="" onChange={onChange} />);
    const input = screen.getByLabelText("開始（直接入力）");
    fireEvent.change(input, { target: { value: "13:05" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith("13:05");
  });

  it("the text field's Enter hands the committed value to onEnter", () => {
    const onChange = vi.fn();
    const onEnter = vi.fn();
    render(<ClockPicker label="開始" value="" onChange={onChange} onEnter={onEnter} />);
    const input = screen.getByLabelText("開始（直接入力）");
    fireEvent.change(input, { target: { value: "09:30" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("09:30");
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith("09:30");
  });
});
