import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { PublicApi } from "../src/api";
import { createDevApi } from "../src/devAdapter";
import { PublicApp } from "../src/PublicApp";
import type { PublicBootstrapData, PublicRangeData } from "../src/types";

afterEach(cleanup);

// Student view tests (Issue #46; DESIGN schedule 7): the
// student preset is a two_column view whose columns are the
// whitelist a student may read — events, lunch, dismissal
// times — headed by the month's accompanying notes （生活目標・
// 健康目標）. What a student must never see is absent twice
// over: the view names no staff-only column, and the range the
// server (here the dev adapter, mirroring it) hands over for a
// non-staff audience carries no absences, no duty assignments
// and no names in the first place.

async function openStudentView(api: ReturnType<typeof createDevApi>) {
  render(<App api={api} initialAnchor="2026-11-16" />);
  await screen.findByText("開発用小学校");
  fireEvent.change(screen.getByLabelText("ビュー"), { target: { value: "view-month-student" } });
  // The month's goals head the table once the student view's
  // range has landed.
  await screen.findByText("あいさつを自分からしよう");
}

describe("the student view on the staff screen (Issue #46)", () => {
  it("shows no staff-only items, duties, names or absences", async () => {
    const api = createDevApi();
    await openStudentView(api);

    // The whitelist's headings stand (twice over: two halves);
    // the staff-only ones never appear.
    expect(screen.getAllByText("行事").length).toBeGreaterThan(0);
    expect(screen.getAllByText("給食").length).toBeGreaterThan(0);
    expect(screen.getAllByText("下校時刻").length).toBeGreaterThan(0);
    expect(screen.queryByText("職員動静")).not.toBeInTheDocument();
    expect(screen.queryByText("〆切")).not.toBeInTheDocument();
    expect(screen.queryByText("清掃")).not.toBeInTheDocument();
    expect(screen.queryByText("日番")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /当番・競合/ })).not.toBeInTheDocument();

    // Student-facing events stand; staff dynamics do not: no
    // teacher's name, no leave, no trip purpose, no provisional
    // staff entry anywhere on the screen.
    expect(screen.getByText("授業参観")).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    for (const hidden of [
      "田中先生",
      "佐藤先生",
      "鈴木先生",
      "年休",
      "県教研大会",
      "生徒指導担当",
    ]) {
      expect(text).not.toContain(hidden);
    }

    // And the bundle itself is clean, not just its rendering:
    // the range for the student view carries no absences, no
    // duty assignments and no conflicts.
    const range = await api.getRange({
      from: "2026-11-01",
      to: "2026-11-30",
      viewId: "view-month-student",
    });
    for (const day of range.days) {
      expect(day.absences).toEqual([]);
      expect(day.dutyAssignments).toEqual([]);
    }
    expect(range.conflicts).toEqual([]);
    expect(JSON.stringify(range.days)).not.toContain("先生");
  });

  it("stands the month in two halves side by side", async () => {
    const api = createDevApi();
    await openStudentView(api);
    const tables = document.querySelectorAll(".two-column table");
    expect(tables).toHaveLength(2);
    const [first, second] = tables as unknown as [HTMLElement, HTMLElement];
    // November 2026 has 30 days: the first half ends on the
    // 15th, the second half runs from the 16th to the 30th.
    expect(first.querySelector('tr[data-date="2026-11-01"]')).not.toBeNull();
    expect(first.querySelector('tr[data-date="2026-11-15"]')).not.toBeNull();
    expect(first.querySelector('tr[data-date="2026-11-16"]')).toBeNull();
    expect(second.querySelector('tr[data-date="2026-11-16"]')).not.toBeNull();
    expect(second.querySelector('tr[data-date="2026-11-30"]')).not.toBeNull();
    expect(second.querySelector('tr[data-date="2026-11-15"]')).toBeNull();
    expect(within(second).getByText("音楽発表会")).toBeInTheDocument();
    // The student table issues like the rows tables do.
    expect(screen.getByRole("button", { name: "発行・印刷" })).toBeInTheDocument();
  });

  it("heads the table with the month's goals, and edits them in place", async () => {
    const api = createDevApi();
    await openStudentView(api);
    expect(screen.getByText("生活目標")).toBeInTheDocument();
    expect(screen.getByText("あいさつを自分からしよう")).toBeInTheDocument();
    expect(screen.getByText("健康目標")).toBeInTheDocument();
    expect(screen.getByText("早寝・早起き・朝ごはん")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "今月の目標を編集" }));
    const lifeInput = await screen.findByLabelText("生活目標");
    expect(lifeInput).toHaveValue("あいさつを自分からしよう");
    expect(screen.getByLabelText("健康目標")).toHaveValue("早寝・早起き・朝ごはん");
    fireEvent.change(lifeInput, { target: { value: "廊下を歩こう" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    // The saved goal heads the table after the re-read, and the
    // adapter's next range carries it — the write went through
    // setViewMonthNote, not just the screen's state.
    expect(await screen.findByText("廊下を歩こう")).toBeInTheDocument();
    expect(screen.queryByText("あいさつを自分からしよう")).not.toBeInTheDocument();
    const range = await api.getRange({
      from: "2026-11-01",
      to: "2026-11-30",
      viewId: "view-month-student",
    });
    expect(range.monthNotes).toEqual([
      { month: "2026-11", lifeGoal: "廊下を歩こう", healthGoal: "早寝・早起き・朝ごはん" },
    ]);
  });

  it("closes the goal editor when the month moves, so one month's goals never land in another", async () => {
    const api = createDevApi();
    await openStudentView(api);

    fireEvent.click(screen.getByRole("button", { name: "今月の目標を編集" }));
    expect(await screen.findByLabelText("生活目標")).toHaveValue("あいさつを自分からしよう");
    expect(screen.getByLabelText("健康目標")).toHaveValue("早寝・早起き・朝ごはん");

    // Move to December with the editor still open: the editor
    // closes with the month, December stands unset, and there
    // is no save button left to press November's text into it.
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    await screen.findByText("2026年12月");
    expect(screen.queryByLabelText("生活目標")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "今月の目標を編集" })).toBeInTheDocument();
    expect(screen.getAllByText("（未設定）").length).toBeGreaterThan(0);

    // Nothing was written anywhere: December carries no note,
    // and November keeps its own goals.
    const december = await api.getRange({
      from: "2026-12-01",
      to: "2026-12-31",
      viewId: "view-month-student",
    });
    expect(december.monthNotes).toEqual([]);
    const november = await api.getRange({
      from: "2026-11-01",
      to: "2026-11-30",
      viewId: "view-month-student",
    });
    expect(november.monthNotes).toEqual([
      {
        month: "2026-11",
        lifeGoal: "あいさつを自分からしよう",
        healthGoal: "早寝・早起き・朝ごはん",
      },
    ]);
  });
});

// The public screen with a student view: the same two halves
// and the same goals header, read-only — no editor is mounted,
// so the header can only show. The fixtures follow
// public.test.tsx's shapes; the note's month is the anchor's
// (this month), as the public screen opens on today.
const NOW = new Date();
const THIS_MONTH = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}`;

const STUDENT_VIEW = {
  id: "view-student",
  name: "生徒用月表",
  layout: "two_column",
  layoutParams: null,
  audience: "student",
  periodScope: "month",
  printSettings: null,
  isArchived: false,
  columns: [
    {
      id: "col-events",
      viewDefinitionId: "view-student",
      sourceKind: "event_category" as const,
      itemDefinitionId: null,
      dutyDefinitionId: null,
      targetGroupId: null,
      groupSameValues: true,
      widthHint: null,
      sort: 1,
    },
    {
      id: "col-lunch",
      viewDefinitionId: "view-student",
      sourceKind: "daily_item" as const,
      itemDefinitionId: "item-lunch",
      dutyDefinitionId: null,
      targetGroupId: null,
      groupSameValues: true,
      widthHint: null,
      sort: 2,
    },
  ],
};

const PUBLIC_BOOT: PublicBootstrapData = {
  school: { id: "school-1", name: "テスト学校" },
  view: STUDENT_VIEW,
  itemDefinitions: [
    {
      id: "item-lunch",
      key: "lunch",
      name: "給食",
      valueType: "symbol",
      targetGroupId: null,
      targetPlatformAxis: null,
      granularity: "day",
      defaultVisibility: "guardian",
      sort: 1,
      isActive: true,
      options: [
        { id: "opt-yes", code: "yes", label: "○", sort: 1 },
        { id: "opt-no", code: "no", label: "×", sort: 2 },
      ],
    },
  ],
  targetGroups: [],
  grades: [],
  holidays: [],
};

const PUBLIC_RANGE: PublicRangeData = {
  view: STUDENT_VIEW,
  from: "2026-11-01",
  to: "2026-11-30",
  days: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].map((date) => ({
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
    events: [],
    absences: [],
    dailyValues: [],
    dutyAssignments: [],
  })),
  undecided: [],
  eventValues: [],
  conflicts: [],
  monthNotes: [
    {
      month: THIS_MONTH,
      lifeGoal: "あいさつを自分からしよう",
      healthGoal: "早寝・早起き・朝ごはん",
    },
  ],
  latestPublication: null,
};

describe("the public screen with a student view (Issue #46)", () => {
  it("renders the two halves and the month's goals, read-only", async () => {
    const api: PublicApi = {
      getPublicBootstrap: async () => structuredClone(PUBLIC_BOOT),
      getPublicRange: async () => structuredClone(PUBLIC_RANGE),
    };
    render(<PublicApp api={api} />);
    expect(await screen.findByText("あいさつを自分からしよう")).toBeInTheDocument();
    expect(screen.getByText("早寝・早起き・朝ごはん")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll(".two-column table")).toHaveLength(2));
    // Read-only: no goal editor, no input anywhere.
    expect(screen.queryByRole("button", { name: "今月の目標を編集" })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });
});
