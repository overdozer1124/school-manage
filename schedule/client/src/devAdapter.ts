import { datesInRange, weekdayOf } from "@school-manage/calendar-types";
import type { RelaySaveResult, ScheduleApi } from "./api";
import type {
  BootstrapData,
  DailyValueData,
  DutyAssignmentData,
  DutyChangeData,
  DutyConflictData,
  EventValueData,
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
 * the server, DESIGN-AUTH-TENANCY 5). It is used only when a
 * development build is opened with `?dev=1`, or the page was built
 * with VITE_SCHEDULE_DEV_ADAPTER=1; production code paths never
 * touch it.
 *
 * The fixture is the elementary-with-bus preset (DESIGN schedule
 * 5.1, schedule/src/definitions/presets.ts `elementary_bus`): the
 * same item definitions, target groups and options, plus sample
 * values for November 2026 — events, lunch, per-grade dismissal
 * times (grouped on screen by Issue #32's pure function), bus
 * times, a duty rotation, one national holiday on a weekday, and
 * undecided events. The shapes are exactly the server actions'
 * result shapes (src/types.ts).
 *
 * Issue #35: the adapter is stateful — each createDevApi() keeps
 * its own events, absences and daily values in memory, and the
 * write actions change them, so the cell editors can be exercised
 * by hand and in tests exactly as against the real server (a saved
 * write is what the next getRange shows). The bootstrap carries
 * the shipped default kind templates and an Admin's permissions.
 * Since Issue #38 the duty side is stateful, like the real
 * server: assignments, changes and waivers live in the adapter
 * instance, the panel's operations rewrite them, and the
 * conflicts getRange returns are derived from them — so applying
 * a substitute in the panel clears the table's warning mark here
 * exactly as it does against the server. Two fixture absences
 * overlap the rotation: a confirmed business trip on 2026-11-12
 * (鈴木先生) and a tentative leave on 2026-11-16 (田中先生).
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
  permissions: [
    "view.read",
    "daily.write",
    "event.write",
    "duty.write",
    "definition.write",
    "publish",
    "view.layout",
    "master.write",
  ],
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
  // The shipped defaults of schedule/src/events/templates.ts.
  kindTemplates: [
    {
      id: "tpl-event",
      key: "event",
      name: "行事",
      subjectKind: "event",
      kindCode: "event",
      personLabel: "担当者",
      displaySource: "title",
      steps: [{ kind: "person" }, { kind: "location" }, { kind: "time" }],
      itemDefinitionIds: [],
      sort: 1,
    },
    {
      id: "tpl-business-trip",
      key: "business_trip",
      name: "出張",
      subjectKind: "absence",
      kindCode: "business_trip",
      personLabel: "出張者",
      displaySource: "person_title",
      steps: [{ kind: "person" }, { kind: "location" }, { kind: "time" }],
      itemDefinitionIds: [],
      sort: 2,
    },
    {
      id: "tpl-deadline",
      key: "deadline",
      name: "〆切",
      subjectKind: "event",
      kindCode: "deadline",
      personLabel: "担当者",
      displaySource: "title",
      steps: [{ kind: "person" }, { kind: "item", itemDefinitionId: null }, { kind: "time" }],
      itemDefinitionIds: [],
      sort: 3,
    },
    {
      id: "tpl-leave",
      key: "leave",
      name: "休暇",
      subjectKind: "absence",
      kindCode: "leave",
      personLabel: "取得者",
      displaySource: "person",
      steps: [{ kind: "person" }, { kind: "subdivision" }, { kind: "time" }],
      itemDefinitionIds: [],
      sort: 4,
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
      rotation: { personIds: STAFF.map((s) => s.id), changeWeekdays: null },
    },
  ],
  // The quick-entry popover's raw materials (Issue #36): a few
  // registered places, the platform's shipped leave subdivisions
  // (packages/calendar-types defaultLeaveSubdivisions), and the
  // default input behaviour — the popover.
  locations: [
    { id: "loc-gym", name: "体育館", kind: null, sort: 1, isActive: true },
    { id: "loc-music", name: "音楽室", kind: null, sort: 2, isActive: true },
    { id: "loc-field", name: "運動場", kind: null, sort: 3, isActive: true },
  ],
  absenceSubdivisions: [
    ["annual", "年休"],
    ["sick", "病休"],
    ["special", "特休"],
    ["summer_special", "夏特"],
    ["nursing", "看護"],
    ["duty_exempt", "職専免"],
    ["compensatory", "振休"],
    ["other", "その他"],
  ].map(([key, label]) => ({
    id: `subdiv-leave-${key}`,
    code: "leave",
    key: key as string,
    label: label as string,
  })),
  inputOpener: "popover",
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
  col(`${viewId}-staff-movement`, viewId, "daily_item", 8, {
    itemDefinitionId: "item-staff-movement",
  }),
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

/** The fixture absences (platform-shaped records): who is away,
 *  when, and whether the absence is confirmed yet. They overlap
 *  the rotation on purpose — see the file header. */
const ABSENCES = [
  {
    id: "abs-trip-1112",
    staffId: "teacher-3",
    kind: "business_trip",
    fromDate: "2026-11-12",
    toDate: "2026-11-12",
    certainty: "confirmed",
  },
  {
    id: "abs-leave-1116",
    staffId: "teacher-1",
    kind: "leave",
    fromDate: "2026-11-16",
    toDate: "2026-11-16",
    certainty: "tentative",
  },
];

function isClassDay(date: string): boolean {
  const weekday = weekdayOf(date);
  return weekday !== "sat" && weekday !== "sun" && !HOLIDAYS[date];
}

/** The rotation's holder for a date: a stable per-date rule (the
 *  roster in order, one step per day from 2026-11-01), so the
 *  same date names the same teacher whatever range is asked. */
function rotationHolder(date: string): string {
  const days = Math.round((Date.parse(date) - Date.parse("2026-11-01")) / 86_400_000);
  const index = ((days % STAFF.length) + STAFF.length) % STAFF.length;
  return (STAFF[index] as (typeof STAFF)[number]).id;
}

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

/** One fixture event as a full platform record (the writes of
 *  Issue #35 need the revision to offer re-edit and delete). */
function fixtureEvent(date: string, title: string, i: number): Record<string, unknown> {
  return {
    id: `ev-${date}-${i}`,
    kind: "event",
    kindLabel: null,
    title,
    datePrecision: "day",
    startsOn: date,
    endsOn: date,
    time: null,
    locationId: null,
    locationText: null,
    description: null,
    certainty: "confirmed",
    visibility: "guardian",
    targets: [],
    impacts: [],
    assignees: [],
    revision: 1,
  };
}

/** The fixture absences: one leave (shown holder-led, 6.3.1) and
 *  one business trip with its purpose. */
function fixtureAbsences(): Record<string, unknown>[] {
  const base = {
    time: { kind: "all_day" },
    certainty: "confirmed",
    note: null,
    revision: 1,
    createdBy: "dev-user",
    confirmedBy: "dev-user",
    confirmedAt: null,
  };
  return [
    {
      ...base,
      id: "abs-1",
      staffId: "teacher-2",
      fromDate: "2026-11-13",
      toDate: "2026-11-13",
      kind: "leave",
      purpose: null,
      // The stored key; the cell line resolves it to the school's
      // word （年休） through the bootstrap's subdivisions.
      subdivisionKey: "annual",
    },
    {
      ...base,
      id: "abs-2",
      staffId: "teacher-1",
      fromDate: "2026-11-20",
      toDate: "2026-11-20",
      kind: "business_trip",
      purpose: "県教研大会",
      subdivisionKey: null,
    },
  ];
}

/** The provisional entries (PR #75 review, 推奨 3): a business
 *  trip whose person is a placeholder name, and one known only
 *  by its title. Both are events of kind "other" carrying the
 *  absence template's name as kindLabel, and both read in the
 *  職員動静 column exactly as typed. */
function fixtureProvisionals(): Record<string, unknown>[] {
  const base = {
    kind: "other",
    kindLabel: "出張",
    datePrecision: "day",
    time: null,
    locationId: null,
    locationText: null,
    description: null,
    certainty: "tentative",
    visibility: "staff_only",
    targets: [],
    impacts: [],
    revision: 1,
  };
  return [
    {
      ...base,
      id: "ev-provisional-name",
      title: "生徒指導担当（出張）",
      startsOn: "2026-11-19",
      endsOn: "2026-11-19",
      assignees: [{ kind: "free_text", name: "生徒指導担当", role: "出張者" }],
    },
    {
      ...base,
      id: "ev-provisional-title",
      title: "生徒指導担当者部会",
      startsOn: "2026-11-26",
      endsOn: "2026-11-26",
      assignees: [],
    },
  ];
}

export function createDevApi(): ScheduleApi {
  // The duty state of this adapter instance (Issue #38): the
  // rotation's assignments by date, the recorded changes, and the
  // waived (assignment, absence) pairs. Panel operations rewrite
  // them, and every later read derives from them.
  const assignments = new Map<string, DutyAssignmentData>();
  const changes: DutyChangeData[] = [];
  const waivers = new Set<string>();
  let changeSeq = 0;

  const ensureAssignment = (date: string): DutyAssignmentData | null => {
    if (!isClassDay(date)) return null;
    const existing = assignments.get(date);
    if (existing) return existing;
    const created: DutyAssignmentData = {
      id: `duty-${date}`,
      dutyDefinitionId: "duty-day",
      date,
      slot: "all_day",
      personId: rotationHolder(date),
      targetId: null,
      origin: "auto",
      note: null,
    };
    assignments.set(date, created);
    return created;
  };

  const deriveConflicts = (from: string, to: string): DutyConflictData[] => {
    const conflicts: DutyConflictData[] = [];
    for (const date of datesInRange(from, to)) {
      const assignment = ensureAssignment(date);
      if (isClassDay(date) && !assignment) {
        conflicts.push({
          kind: "unassigned",
          assignmentId: null,
          otherAssignmentId: null,
          dutyDefinitionId: "duty-day",
          dutyName: "日番",
          date,
          slot: "all_day",
          personId: null,
          absenceId: null,
          absenceKind: null,
          certainty: null,
        });
        continue;
      }
      if (!assignment) continue;
      for (const absence of ABSENCES) {
        if (absence.fromDate > date || absence.toDate < date) continue;
        if (assignment.personId !== absence.staffId) continue;
        if (waivers.has(`${assignment.id}|${absence.id}`)) continue;
        conflicts.push({
          kind: "absence",
          assignmentId: assignment.id,
          otherAssignmentId: null,
          dutyDefinitionId: "duty-day",
          dutyName: "日番",
          date,
          slot: "all_day",
          personId: assignment.personId,
          absenceId: absence.id,
          absenceKind: absence.kind,
          certainty: absence.certainty,
        });
      }
    }
    return conflicts;
  };

  const findAssignment = (id: string): DutyAssignmentData => {
    for (const assignment of assignments.values()) {
      if (assignment.id === id) return assignment;
    }
    throw new Error(`duty assignment not found: ${id}`);
  };

  function devDay(date: string): RangeDayData {
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
    const assignment = ensureAssignment(date);
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
      holidays: holiday
        ? [{ id: `hol-${date}`, date, name: holiday, kind: "national_holiday" }]
        : [],
      // Events and absences live in the adapter's state (below), so
      // writes show up on the next read; devDay itself stays the
      // pure per-day fixture for days, holidays, values and duties.
      events: [],
      absences: [],
      dailyValues,
      dutyAssignments: assignment ? [structuredClone(assignment)] : [],
    };
  }

  const state = {
    events: [
      ...Object.entries(EVENTS).flatMap(([date, titles]) =>
        titles.map((title, i) => fixtureEvent(date, title, i)),
      ),
      ...fixtureProvisionals(),
    ],
    absences: fixtureAbsences(),
    daily: new Map<string, DailyValueData[]>(),
    // A record's additional items (Issue #36), keyed by subject.
    eventValues: new Map<string, EventValueData[]>(),
  };
  let eventValueSeq = 0;

  /** The day's stored daily values, seeded from the fixture on
   *  first write (reads alone never copy them into the state). */
  const storedDaily = (date: string): DailyValueData[] => {
    let values = state.daily.get(date);
    if (!values) {
      values = devDay(date).dailyValues.map((v) => ({ ...v }));
      state.daily.set(date, values);
    }
    return values;
  };

  /** A stored value's target identity (target ids are unique
   *  across the fixture's groups and axes). */
  const targetKeyOf = (v: DailyValueData): string | null => v.targetId ?? v.targetRef?.id ?? null;

  /** The stored columns a written value lands in, per value type —
   *  the fixture's loose mirror of the server's validator. */
  const columnsFor = (
    itemDef: BootstrapData["itemDefinitions"][number],
    written: unknown,
  ): Partial<DailyValueData> => {
    switch (itemDef.valueType) {
      case "symbol":
      case "code":
        return {
          valueOptionId: itemDef.options.find((o) => o.code === written)?.id ?? null,
        };
      case "time":
        return { valueTime: written as string };
      case "time_range": {
        const range = written as { startsAt: string; endsAt: string };
        return { valueTime: range.startsAt, valueTimeEnd: range.endsAt };
      }
      case "text":
        return { valueText: written as string };
      case "number":
        return { valueNumber: written as number };
      case "boolean":
        return { valueBoolean: written as boolean };
      case "person":
        return { valuePersonId: written as string };
      default:
        return {};
    }
  };
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
        days: dates.map((date) => {
          const base = devDay(date);
          return {
            ...base,
            events: state.events.filter(
              (e) =>
                typeof e["startsOn"] === "string" &&
                typeof e["endsOn"] === "string" &&
                (e["startsOn"] as string) <= date &&
                date <= (e["endsOn"] as string),
            ),
            absences: state.absences.filter(
              (a) =>
                typeof a["fromDate"] === "string" &&
                typeof a["toDate"] === "string" &&
                (a["fromDate"] as string) <= date &&
                date <= (a["toDate"] as string),
            ),
            dailyValues: state.daily.get(date) ?? base.dailyValues,
          };
        }),
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
        conflicts: view.audience === "staff" ? deriveConflicts(input.from, input.to) : [],
      } satisfies RangeData;
    },
    async createEvent(input): Promise<RelaySaveResult> {
      const record = { ...input.event, revision: 1 };
      state.events.push(record);
      return { record, values: [] };
    },
    async updateEvent(input): Promise<RelaySaveResult> {
      const index = state.events.findIndex((e) => e["id"] === input.id);
      if (index < 0) throw new Error(`event not found: ${input.id}`);
      const record = { ...input.event, id: input.id, revision: input.revision + 1 };
      state.events[index] = record;
      return { record, values: null };
    },
    async deleteEvent(input) {
      state.events = state.events.filter((e) => e["id"] !== input.id);
      return { deleted: true as const };
    },
    async createAbsence(input): Promise<RelaySaveResult> {
      const record = {
        ...input.absence,
        revision: 1,
        createdBy: "dev-user",
        confirmedBy: null,
        confirmedAt: null,
      };
      state.absences.push(record);
      return { record, values: [] };
    },
    async updateAbsence(input): Promise<RelaySaveResult> {
      const index = state.absences.findIndex((a) => a["id"] === input.id);
      if (index < 0) throw new Error(`absence not found: ${input.id}`);
      const record = { ...input.absence, id: input.id, revision: input.revision + 1 };
      state.absences[index] = record;
      return { record, values: null };
    },
    async deleteAbsence(input) {
      state.absences = state.absences.filter((a) => a["id"] !== input.id);
      return { deleted: true as const };
    },
    async setDailyValue(input) {
      const itemDef = DEV_BOOTSTRAP.itemDefinitions.find((i) => i.id === input.itemDefinitionId);
      if (!itemDef) throw new Error(`item definition not found: ${input.itemDefinitionId}`);
      const values = storedDaily(input.date);
      const targetKey = input.target?.id ?? null;
      const columns = columnsFor(itemDef, input.value);
      const existing = values.find(
        (v) => v.itemDefinitionId === itemDef.id && targetKeyOf(v) === targetKey,
      );
      if (existing) {
        Object.assign(existing, {
          valueText: null,
          valueTime: null,
          valueTimeEnd: null,
          valueNumber: null,
          valueBoolean: null,
          valueOptionId: null,
          valuePersonId: null,
          ...columns,
        });
        return existing;
      }
      const stored = value({
        date: input.date,
        itemDefinitionId: itemDef.id,
        targetId: input.target?.axis === "app" ? input.target.id : null,
        targetRef:
          input.target && input.target.axis !== "app"
            ? { axis: input.target.axis, id: input.target.id }
            : null,
        ...columns,
      });
      values.push(stored);
      return stored;
    },
    async deleteDailyValue(input) {
      const values = storedDaily(input.date);
      const targetKey = input.target?.id ?? null;
      const index = values.findIndex(
        (v) => v.itemDefinitionId === input.itemDefinitionId && targetKeyOf(v) === targetKey,
      );
      if (index < 0) throw new Error("daily value not found");
      values.splice(index, 1);
      return { deleted: true as const };
    },
    // The quick-entry popover's item step (Issue #36): a record's
    // additional items, held in memory like the rest of the state
    // and rewritten as one set, as the server's action does.
    async getEventValues(input) {
      return structuredClone(state.eventValues.get(input.subjectId) ?? []);
    },
    async setEventValues(input) {
      const rows: EventValueData[] = input.values.map((entry) => {
        const itemDef = DEV_BOOTSTRAP.itemDefinitions.find((i) => i.id === entry.itemDefinitionId);
        if (!itemDef) throw new Error(`item definition not found: ${entry.itemDefinitionId}`);
        const columns = columnsFor(itemDef, entry.value);
        return {
          id: `evv-${++eventValueSeq}`,
          itemDefinitionId: entry.itemDefinitionId,
          targetId: entry.target?.axis === "app" ? entry.target.id : null,
          targetRef:
            entry.target && entry.target.axis !== "app"
              ? { axis: entry.target.axis, id: entry.target.id }
              : null,
          valueText: columns.valueText ?? null,
          valueTime: columns.valueTime ?? null,
          valueTimeEnd: columns.valueTimeEnd ?? null,
          valueNumber: columns.valueNumber ?? null,
          valueBoolean: columns.valueBoolean ?? null,
          valueOptionId: columns.valueOptionId ?? null,
          valuePersonId: columns.valuePersonId ?? null,
        };
      });
      state.eventValues.set(input.subjectId, rows);
      return structuredClone(rows);
    },

    async previewRotation(input) {
      return datesInRange(input.from, input.to)
        .filter((date) => isClassDay(date))
        .map((date) => {
          const existing = ensureAssignment(date);
          const personId = rotationHolder(date);
          const action =
            !existing || existing.personId === null
              ? ("create" as const)
              : existing.origin === "auto" && existing.personId !== personId
                ? ("replace" as const)
                : ("keep" as const);
          return {
            date,
            slot: "all_day",
            personId,
            action: existing ? action : ("create" as const),
            existing: existing ? structuredClone(existing) : null,
          };
        });
    },

    async applyRotation(input) {
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const result: DutyAssignmentData[] = [];
      for (const date of datesInRange(input.from, input.to)) {
        if (!isClassDay(date)) continue;
        const personId = rotationHolder(date);
        const existing = assignments.get(date);
        if (!existing) {
          const assignment = ensureAssignment(date) as DutyAssignmentData;
          created += 1;
          result.push(structuredClone(assignment));
          continue;
        }
        if (existing.origin === "auto" && existing.personId !== personId) {
          existing.personId = personId;
          updated += 1;
        } else {
          skipped += 1;
        }
        result.push(structuredClone(existing));
      }
      return { created, updated, skipped, assignments: result };
    },

    async proposeDutyChange(input) {
      const a = findAssignment(input.assignmentAId);
      const b = input.assignmentBId ? findAssignment(input.assignmentBId) : null;
      changeSeq += 1;
      const change: DutyChangeData = {
        id: `change-${changeSeq}`,
        dutyDefinitionId: a.dutyDefinitionId,
        kind: input.kind,
        assignmentAId: a.id,
        assignmentBId: b?.id ?? null,
        fromPersonId: a.personId,
        toPersonId: input.kind === "swap" ? (b?.personId ?? null) : (input.toPersonId ?? null),
        reason: input.reason ?? "",
        requestedBy: "dev-user",
        approvedBy: null,
        status: "proposed",
        createdAt: new Date().toISOString(),
        appliedAt: null,
      };
      changes.push(change);
      return structuredClone(change);
    },

    async applyDutyChange(input) {
      const change = changes.find((c) => c.id === input.id);
      if (!change) throw new Error(`duty change not found: ${input.id}`);
      const a = findAssignment(change.assignmentAId);
      if (change.kind === "swap" && change.assignmentBId) {
        const b = findAssignment(change.assignmentBId);
        const holder = a.personId;
        a.personId = b.personId;
        b.personId = holder;
        a.origin = "swap";
        b.origin = "swap";
      } else {
        a.personId = change.toPersonId;
        a.origin = "swap";
      }
      change.status = "applied";
      change.approvedBy = "dev-user";
      change.appliedAt = new Date().toISOString();
      return structuredClone(change);
    },

    async declineDutyChange(input) {
      const change = changes.find((c) => c.id === input.id);
      if (!change) throw new Error(`duty change not found: ${input.id}`);
      change.status = "declined";
      change.approvedBy = "dev-user";
      return structuredClone(change);
    },

    async getDutyChanges() {
      return structuredClone([...changes].reverse());
    },

    async getDutyConflicts(input) {
      return deriveConflicts(input.from, input.to);
    },

    async waiveConflict(input) {
      waivers.add(`${input.assignmentId}|${input.absenceId}`);
      return { waived: true };
    },

    async getDutyChangeCandidates(input) {
      const a = findAssignment(input.assignmentId);
      const absent = new Set(
        ABSENCES.filter((x) => x.fromDate <= a.date && a.date <= x.toDate).map((x) => x.staffId),
      );
      const roster = STAFF.map((s) => s.id);
      const start = a.personId ? roster.indexOf(a.personId) : -1;
      const ordered: string[] = [];
      for (let step = 1; step <= roster.length; step += 1) {
        const id = roster[(start + step) % roster.length] as string;
        if (id !== a.personId && !absent.has(id)) ordered.push(id);
      }
      return ordered;
    },
  };
}

/** Whether the page should use the development adapter: a build
 *  made with the env flag, or — in a development build only — an
 *  explicit `?dev=1` in the URL. A production build never switches
 *  to the fake data from the URL alone (PR #73 review): the flag is
 *  a build-time choice, the query is not. */
export function devAdapterEnabled(
  search: string,
  envFlag: string | undefined,
  isDevBuild: boolean,
): boolean {
  if (envFlag === "1") return true;
  if (!isDevBuild) return false;
  return new URLSearchParams(search).get("dev") === "1";
}
