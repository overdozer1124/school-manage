import { datesInRange, weekdayOf } from "@school-manage/calendar-types";
import type { ScheduleApi } from "./api";
import type {
  BootstrapData,
  DailyValueData,
  RangeData,
  RangeDayData,
  ViewDefinitionData,
} from "./types";

/**
 * The development adapter for the screens (Issue #34): a
 * ScheduleApi that answers from fixture data instead of the server,
 * so the screens can be started, checked and screenshotted before
 * the platform and this server are wired together in an environment
 * (the same role the platform-client's dev auth adapter plays for
 * the server, DESIGN-AUTH-TENANCY 5). It is used only when the page
 * is opened with `?dev=1` or built with VITE_SCHEDULE_DEV_ADAPTER=1;
 * production code paths never touch it.
 *
 * The fixture is the elementary-with-bus preset (DESIGN schedule
 * 5.1, schedule/src/definitions/presets.ts `elementary_bus`): the
 * same item definitions, target groups and options, plus sample
 * values for November 2026 — events, lunch, per-grade dismissal
 * times (grouped on screen by Issue #32's pure function), bus
 * times, a duty rotation, one national holiday on a weekday, and
 * undecided events. The shapes are exactly the server actions'
 * result shapes (src/types.ts).
 */

const GRADES = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `grade-${n}`, name: `${n}年` }));
const STAFF = [
  { id: "teacher-1", name: "田中先生" },
  { id: "teacher-2", name: "佐藤先生" },
  { id: "teacher-3", name: "鈴木先生" },
];

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
  defaultVisibility: "guardian",
  sort,
  options: [],
  ...extra,
});

const yesNo = (itemKey: string) => [
  { id: `opt-${itemKey}-yes`, code: "yes", label: "○", sort: 1 },
  { id: `opt-${itemKey}-no`, code: "no", label: "×", sort: 2 },
];

export const DEV_BOOTSTRAP: BootstrapData = {
  school: { id: "dev-school", name: "開発用小学校" },
  userId: "dev-user",
  teacherId: "teacher-1",
  role: "Admin",
  permissions: ["view.read"],
  views: [], // filled below (needs the column helper)
  itemDefinitions: [
    item("item-events", "events", "行事", "event_list", 1),
    item("item-lunch", "lunch", "給食", "symbol", 2, {
      options: [
        { id: "opt-lunch-yes", code: "yes", label: "○", sort: 1 },
        { id: "opt-lunch-no", code: "no", label: "×", sort: 2 },
      ],
    }),
    item("item-dismissal", "dismissal", "下校時刻", "time", 3, {
      targetPlatformAxis: "grade",
    }),
    item("item-bus", "bus", "スクールバス", "time", 4, { targetGroupId: "tg-bus-route" }),
    item("item-cleaning", "cleaning", "清掃", "symbol", 5, {
      defaultVisibility: "staff_only",
      options: yesNo("cleaning"),
    }),
    item("item-staff-movement", "staff_movement", "職員動静", "event_list", 7, {
      defaultVisibility: "staff_only",
    }),
    item("item-deadline", "deadline", "〆切", "event_list", 8, {
      defaultVisibility: "staff_only",
    }),
  ],
  targetGroups: [
    {
      id: "tg-bus-route",
      key: "bus_route",
      name: "スクールバス便",
      sort: 1,
      targets: [1, 2, 3, 4].map((n) => ({
        id: `tgt-bus-${n}`,
        targetGroupId: "tg-bus-route",
        code: String(n),
        name: `${["①", "②", "③", "④"][n - 1]}便`,
        sort: n,
      })),
    },
  ],
  kindTemplates: [],
  masters: {
    staff: STAFF,
    grades: GRADES,
    dayPatterns: [{ id: "pattern-a", code: "A", name: "A日課" }],
  },
};

const col = (
  id: string,
  viewDefinitionId: string,
  sourceKind: "event_category" | "daily_item" | "duty" | "day_attribute",
  sort: number,
  extra: Partial<ViewDefinitionData["columns"][number]> = {},
): ViewDefinitionData["columns"][number] => ({
  id,
  viewDefinitionId,
  sourceKind,
  itemDefinitionId: null,
  dutyDefinitionId: null,
  targetGroupId: null,
  groupSameValues: true,
  widthHint: null,
  sort,
  ...extra,
});

const staffColumns = (viewId: string): ViewDefinitionData["columns"] => [
  col(`${viewId}-events`, viewId, "event_category", 1),
  col(`${viewId}-lunch`, viewId, "daily_item", 2, { itemDefinitionId: "item-lunch" }),
  col(`${viewId}-dismissal`, viewId, "daily_item", 3, { itemDefinitionId: "item-dismissal" }),
  col(`${viewId}-bus`, viewId, "daily_item", 4, { itemDefinitionId: "item-bus" }),
  col(`${viewId}-cleaning`, viewId, "daily_item", 5, { itemDefinitionId: "item-cleaning" }),
  col(`${viewId}-duty`, viewId, "duty", 6, { dutyDefinitionId: "duty-day" }),
  col(`${viewId}-deadline`, viewId, "daily_item", 7, { itemDefinitionId: "item-deadline" }),
];

DEV_BOOTSTRAP.views = [
  {
    id: "view-month-staff",
    name: "職員用月表",
    layout: "month_rows",
    layoutParams: null,
    audience: "staff",
    periodScope: "month",
    printSettings: null,
    columns: staffColumns("view-month-staff"),
  },
  {
    id: "view-week-staff",
    name: "職員用週表（2週間）",
    layout: "week_rows",
    layoutParams: { days: 14 },
    audience: "staff",
    periodScope: "two_weeks",
    printSettings: null,
    columns: staffColumns("view-week-staff"),
  },
  {
    id: "view-month-guardian",
    name: "保護者用月表",
    layout: "month_rows",
    layoutParams: null,
    audience: "guardian",
    periodScope: "month",
    printSettings: null,
    columns: [
      col("view-month-guardian-events", "view-month-guardian", "event_category", 1),
      col("view-month-guardian-lunch", "view-month-guardian", "daily_item", 2, {
        itemDefinitionId: "item-lunch",
      }),
      col("view-month-guardian-dismissal", "view-month-guardian", "daily_item", 3, {
        itemDefinitionId: "item-dismissal",
      }),
      col("view-month-guardian-bus", "view-month-guardian", "daily_item", 4, {
        itemDefinitionId: "item-bus",
      }),
    ],
  },
];

const HOLIDAYS: Record<string, string> = {
  "2026-11-03": "文化の日",
  "2026-11-23": "勤労感謝の日",
};

const EVENTS: Record<string, string[]> = {
  "2026-11-06": ["授業参観"],
  "2026-11-12": ["マラソン大会"],
  "2026-11-18": ["避難訓練"],
  "2026-11-25": ["音楽発表会"],
  "2026-11-30": ["委員会活動"],
};

let valueSeq = 0;
function value(
  partial: Partial<DailyValueData> & { date: string; itemDefinitionId: string },
): DailyValueData {
  valueSeq += 1;
  return {
    id: `dv-${valueSeq}`,
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

function devDay(date: string, index: number): RangeDayData {
  const weekday = weekdayOf(date);
  const holiday = HOLIDAYS[date];
  const isWeekend = weekday === "sat" || weekday === "sun";
  const classDay = !isWeekend && !holiday;
  const dailyValues: DailyValueData[] = [];
  dailyValues.push(
    value({
      date,
      itemDefinitionId: "item-lunch",
      valueOptionId: classDay ? "opt-lunch-yes" : "opt-lunch-no",
    }),
  );
  if (classDay) {
    // Dismissal: Mon/Wed/Fri split by grade band, Tue/Thu one time
    // for everyone — the two grouping shapes of DESIGN 4.8.2.
    const split = weekday === "mon" || weekday === "wed" || weekday === "fri";
    for (const grade of GRADES) {
      const n = Number(grade.id.slice(-1));
      dailyValues.push(
        value({
          date,
          itemDefinitionId: "item-dismissal",
          targetRef: { axis: "grade", id: grade.id },
          valueTime: split && n >= 4 ? "15:20" : "14:30",
        }),
      );
    }
    dailyValues.push(
      value({ date, itemDefinitionId: "item-bus", targetId: "tgt-bus-1", valueTime: "14:40" }),
      value({ date, itemDefinitionId: "item-bus", targetId: "tgt-bus-2", valueTime: "15:30" }),
      value({ date, itemDefinitionId: "item-cleaning", valueOptionId: "opt-cleaning-yes" }),
    );
  }
  return {
    date,
    day: {
      date,
      dayType: classDay ? "class_day" : "closed_day",
      dayTypeLabel: null,
      dayScheduleId: classDay ? "pattern-a" : null,
      weekdaySwap: null,
      note: null,
      source: "default",
    },
    holidays: holiday ? [{ id: `hol-${date}`, date, name: holiday, kind: "national_holiday" }] : [],
    events: (EVENTS[date] ?? []).map((title, i) => ({
      id: `ev-${date}-${i}`,
      kind: "event",
      title,
      datePrecision: "day",
      startsOn: date,
      endsOn: date,
      certainty: "confirmed",
      visibility: "guardian",
    })),
    absences: [],
    dailyValues,
    dutyAssignments: classDay
      ? [
          {
            id: `duty-${date}`,
            dutyDefinitionId: "duty-day",
            date,
            slot: "all_day",
            personId: (STAFF[index % STAFF.length] as (typeof STAFF)[number]).id,
            note: null,
          },
        ]
      : [],
  };
}

export function createDevApi(): ScheduleApi {
  return {
    async getBootstrap() {
      return structuredClone(DEV_BOOTSTRAP);
    },
    async getRange(input) {
      const view =
        DEV_BOOTSTRAP.views.find((v) => v.id === input.viewId) ??
        (DEV_BOOTSTRAP.views[0] as ViewDefinitionData);
      const dates = datesInRange(input.from, input.to);
      valueSeq = 0;
      return {
        view: structuredClone(view),
        from: input.from,
        to: input.to,
        days: dates.map((date, i) => devDay(date, i)),
        undecided: [
          {
            month: "2026-11",
            events: [
              {
                id: "ev-undecided-month",
                kind: "event",
                title: "作品展",
                datePrecision: "month",
                startsOn: "2026-11-15",
                endsOn: "2026-11-15",
                certainty: "tentative",
                visibility: "guardian",
              },
            ],
          },
          {
            month: null,
            events: [
              {
                id: "ev-undecided-year",
                kind: "event",
                title: "研究発表会",
                datePrecision: "undecided",
                startsOn: "2026-04-01",
                endsOn: "2026-04-01",
                certainty: "tentative",
                visibility: "guardian",
              },
            ],
          },
        ],
        eventValues: [],
        conflicts: [],
      } satisfies RangeData;
    },
  };
}

/** Whether the page should use the development adapter: an explicit
 *  `?dev=1` in the URL, or a build made with the env flag. */
export function devAdapterEnabled(search: string, envFlag: string | undefined): boolean {
  if (envFlag === "1") return true;
  return new URLSearchParams(search).get("dev") === "1";
}
