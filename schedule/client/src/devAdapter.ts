import {
  audienceColumns,
  audienceItems,
  datesInRange,
  isVisibleTo,
  viewAudienceRank,
  weekdayOf,
  type Audience,
  type Visibility,
} from "@school-manage/calendar-types";
import {
  ApiError,
  UnauthorizedError,
  type PublicApi,
  type RelaySaveResult,
  type ScheduleApi,
} from "./api";
import {
  absenceLineText,
  columnLabel,
  dailyCellText,
  dayAttributeText,
  dayMark,
  dutyCellLines,
  eventTimeText,
  eventTitle,
  monthEndOf,
  monthStartOf,
  provisionalLineText,
  provisionalTemplateOf,
  weekdayLabel,
} from "./lib";
import type {
  AbsenceSubdivisionData,
  BootstrapData,
  DailyValueData,
  DefinitionSetData,
  DutyAssignmentData,
  DutyChangeData,
  DutyConflictData,
  EventValueData,
  ItemDefinitionData,
  LocationData,
  MastersData,
  PrintSettingsData,
  PublicationData,
  PublicBootstrapData,
  PublicViewTokenData,
  RangeData,
  RangeDayData,
  SchoolSettingsData,
  ViewDefinitionData,
  ViewMonthNoteData,
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

/** The club symbols of the junior-high preset
 *  (schedule/src/definitions/presets.ts clubOptions). */
const clubOptions = (itemKey: string) => [
  { id: `opt-${itemKey}-practice`, code: "practice", label: "練", sort: 1 },
  { id: `opt-${itemKey}-off`, code: "off", label: "休", sort: 2 },
  { id: `opt-${itemKey}-tournament`, code: "tournament", label: "大", sort: 3 },
  { id: `opt-${itemKey}-morning`, code: "morning", label: "前", sort: 4 },
  { id: `opt-${itemKey}-afternoon`, code: "afternoon", label: "後", sort: 5 },
  { id: `opt-${itemKey}-meeting`, code: "meeting", label: "ミ", sort: 6 },
];

const CLUB_TARGETS = [
  { id: "tgt-club-baseball", targetGroupId: "tg-club", code: null, name: "野球部", sort: 1 },
  { id: "tgt-club-soccer", targetGroupId: "tg-club", code: null, name: "サッカー部", sort: 2 },
  { id: "tgt-club-brass", targetGroupId: "tg-club", code: null, name: "吹奏楽部", sort: 3 },
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
    // Lunch and dismissal reach students in this school: the
    // shipped preset defaults an item's reach to guardians, and
    // a school that turns the student table on (Issue #46)
    // widens the items it shows there to student reach — the
    // fixture school has done so, as its student view below
    // expects.
    item("item-lunch", "lunch", "給食", "symbol", 2, {
      defaultVisibility: "student",
      options: [
        { id: "opt-lunch-yes", code: "yes", label: "○", sort: 1 },
        { id: "opt-lunch-no", code: "no", label: "×", sort: 2 },
      ],
    }),
    item("item-dismissal", "dismissal", "下校時刻", "time", 3, {
      targetPlatformAxis: "grade",
      defaultVisibility: "student",
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
    // The junior-high preset's per-club item (Issue #45): the
    // dev school runs a club programme alongside the bus
    // preset, so the transposed club table has its axis and
    // item from the start, as the other layouts' views do.
    item("item-club-activity", "club_activity", "部活動（部別）", "symbol", 10, {
      targetGroupId: "tg-club",
      defaultVisibility: "staff_only",
      options: clubOptions("club-activity"),
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
    {
      id: "tg-club",
      key: "club",
      name: "部活動",
      sort: 2,
      targets: CLUB_TARGETS,
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
      isActive: true,
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
  // The shipped defaults carry the platform's apply-defaults
  // order (Issue #91): 年休・特休・夏特・病休・看護・振休・
  // 職専免・その他, in steps of ten.
  absenceSubdivisions: [
    ["annual", "年休", 10],
    ["special", "特休", 20],
    ["summer_special", "夏特", 30],
    ["sick", "病休", 40],
    ["nursing", "看護", 50],
    ["compensatory", "振休", 60],
    ["duty_exempt", "職専免", 70],
    ["other", "その他", 80],
  ].map(([key, label, sort]) => ({
    id: `subdiv-leave-${key}`,
    code: "leave",
    key: key as string,
    label: label as string,
    sort: sort as number,
    revision: 1,
  })),
  inputOpener: "popover",
  masters: {
    staff: STAFF,
    grades: GRADES,
    dayPatterns: [
      {
        id: "pattern-a",
        code: "A",
        name: "A日課",
        // The pattern's lesson periods, in the platform record's
        // shape: the detail modal's 時限指定 offers them
        // (Issue #37).
        periods: [
          { period: 1, label: "1限", startsAt: "08:50", endsAt: "09:40" },
          { period: 2, label: "2限", startsAt: "09:50", endsAt: "10:40" },
          { period: 3, label: "3限", startsAt: "10:50", endsAt: "11:40" },
          { period: 4, label: "4限", startsAt: "11:50", endsAt: "12:40" },
          { period: 5, label: "5限", startsAt: "13:30", endsAt: "14:20" },
          { period: 6, label: "6限", startsAt: "14:30", endsAt: "15:20" },
        ],
      },
    ],
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
    isArchived: false,
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
    isArchived: false,
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
    isArchived: false,
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
  {
    // The L3 year table (Issue #42): a narrowed column set, as
    // the design expects of a year view — events and lunch only.
    id: "view-year-staff",
    name: "職員用年間表",
    layout: "year_columns",
    layoutParams: null,
    audience: "staff",
    periodScope: "year",
    printSettings: null,
    isArchived: false,
    columns: [
      col("view-year-staff-events", "view-year-staff", "event_category", 1),
      col("view-year-staff-lunch", "view-year-staff", "daily_item", 2, {
        itemDefinitionId: "item-lunch",
      }),
    ],
  },
  {
    // The L4 calendar grid (Issue #43): a narrowed column set,
    // as the design expects of a grid view — events and lunch
    // only. No weekStart in the layout params: the weeks start
    // on Monday, the school default.
    id: "view-calendar-staff",
    name: "職員用カレンダー",
    layout: "calendar_grid",
    layoutParams: null,
    audience: "staff",
    periodScope: "month",
    printSettings: null,
    isArchived: false,
    columns: [
      col("view-calendar-staff-events", "view-calendar-staff", "event_category", 1),
      col("view-calendar-staff-lunch", "view-calendar-staff", "daily_item", 2, {
        itemDefinitionId: "item-lunch",
      }),
    ],
  },
  {
    // The L5 week timeline (Issue #44): the clock axis with its
    // default range (7:00–19:00, 30-minute step). The columns
    // name what the timeline's band input creates and reads —
    // events, with lunch kept for the day detail's sake.
    id: "view-timeline-staff",
    name: "職員用タイムライン",
    layout: "week_timeline",
    layoutParams: null,
    audience: "staff",
    periodScope: "week",
    printSettings: null,
    isArchived: false,
    columns: [
      col("view-timeline-staff-events", "view-timeline-staff", "event_category", 1),
      col("view-timeline-staff-lunch", "view-timeline-staff", "daily_item", 2, {
        itemDefinitionId: "item-lunch",
      }),
    ],
  },
  {
    // The timeline's period axis （時限軸モード）: the same view
    // with layoutParams.axis = "period" — the rows become the
    // day patterns' periods instead of clock hours.
    id: "view-timeline-period",
    name: "職員用タイムライン（時限）",
    layout: "week_timeline",
    layoutParams: { axis: "period" },
    audience: "staff",
    periodScope: "week",
    printSettings: null,
    isArchived: false,
    columns: [
      col("view-timeline-period-events", "view-timeline-period", "event_category", 1),
      col("view-timeline-period-lunch", "view-timeline-period", "daily_item", 2, {
        itemDefinitionId: "item-lunch",
      }),
    ],
  },
  {
    // The transposed table (Issue #45; DESIGN schedule 5.2
    // scenario 5): rows are the clubs, columns the month's
    // days, cells each club's 部活動（部別） value. The scope
    // is the month, as the club tables are kept.
    id: "view-club-staff",
    name: "部活動表",
    layout: "transposed",
    layoutParams: null,
    audience: "staff",
    periodScope: "month",
    printSettings: null,
    isArchived: false,
    columns: [
      col("view-club-staff-club", "view-club-staff", "daily_item", 1, {
        itemDefinitionId: "item-club-activity",
        targetGroupId: "tg-club",
      }),
    ],
  },
  {
    // The student preset (Issue #46; DESIGN schedule 7): the
    // two-column layout over one month, its columns the
    // whitelist a student may read — events, lunch and the
    // per-grade dismissal times. Nothing staff-only stands
    // here: no 職員動静， no 〆切, no duty column, and the
    // range read for a non-staff audience carries no absences
    // or names in the first place.
    id: "view-month-student",
    name: "生徒用月表",
    layout: "two_column",
    layoutParams: null,
    audience: "student",
    periodScope: "month",
    printSettings: null,
    isArchived: false,
    columns: [
      col("view-month-student-events", "view-month-student", "event_category", 1),
      col("view-month-student-lunch", "view-month-student", "daily_item", 2, {
        itemDefinitionId: "item-lunch",
      }),
      col("view-month-student-dismissal", "view-month-student", "daily_item", 3, {
        itemDefinitionId: "item-dismissal",
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

/** The timed fixture events (Issue #44): what the week timeline
 *  draws as blocks — two overlapping pairs (so the lanes show),
 *  one periods-timed event (so the period axis has a native
 *  entry), and one all-day event for the band, in the weeks of
 *  November 9 and November 16, 2026. */
const TIMED_EVENTS: { date: string; title: string; time: unknown }[] = [
  {
    date: "2026-11-10",
    title: "研究授業",
    time: { kind: "clock", startsAt: "09:00", endsAt: "10:30" },
  },
  {
    date: "2026-11-10",
    title: "学年会議",
    time: { kind: "clock", startsAt: "10:00", endsAt: "11:00" },
  },
  {
    date: "2026-11-11",
    title: "クラブ活動",
    time: { kind: "clock", startsAt: "13:30", endsAt: "14:20" },
  },
  {
    date: "2026-11-12",
    title: "遠足",
    time: { kind: "all_day" },
  },
  {
    date: "2026-11-16",
    title: "朝会",
    time: { kind: "clock", startsAt: "08:30", endsAt: "08:50" },
  },
  {
    date: "2026-11-16",
    title: "打ち合わせ",
    time: { kind: "clock", startsAt: "08:40", endsAt: "09:30" },
  },
  {
    date: "2026-11-16",
    title: "職員会議",
    time: { kind: "clock", startsAt: "15:30", endsAt: "16:30" },
  },
  {
    date: "2026-11-17",
    title: "総合学習発表",
    time: { kind: "periods", from: 2, to: 3 },
  },
];

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
function fixtureEvent(
  date: string,
  title: string,
  i: number,
  time: unknown = null,
  visibility: string = "student",
): Record<string, unknown> {
  return {
    id: `ev-${date}-${i}`,
    kind: "event",
    kindLabel: null,
    title,
    datePrecision: "day",
    startsOn: date,
    endsOn: date,
    time,
    locationId: null,
    locationText: null,
    description: null,
    certainty: "confirmed",
    // The seeded events are whole-school events, written to
    // reach students (and so guardians and staff as well): the
    // student table's 行事 column is filled from them. The
    // timed fixtures below name their own reach (guardian):
    // they are the staff timeline's material.
    visibility,
    targets: [],
    impacts: [],
    assignees: [],
    revision: 1,
    // The confirmation record the platform keeps (Issue #85), so
    // the detail modal shows its 確定 line here as in production.
    createdBy: "dev-user",
    confirmedBy: "dev-user",
    confirmedAt: "2026-11-01T09:00:00.000Z",
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
    {
      // A tentative trip, so the confirmation queue (Issue #39)
      // has an absence to show next to the provisional events.
      ...base,
      id: "abs-3",
      staffId: "teacher-3",
      fromDate: "2026-11-24",
      toDate: "2026-11-24",
      kind: "business_trip",
      purpose: "市教研研修会",
      subdivisionKey: null,
      certainty: "tentative",
      confirmedBy: null,
    },
    {
      // A part-day leave with clock times (Issue #44): the week
      // timeline draws it as a timed block, not in the band.
      ...base,
      id: "abs-4",
      staffId: "teacher-2",
      fromDate: "2026-11-17",
      toDate: "2026-11-17",
      kind: "leave",
      purpose: null,
      subdivisionKey: "annual",
      time: { kind: "clock", startsAt: "10:00", endsAt: "11:00" },
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

function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PRINT_FONT_SIZES: Record<PrintSettingsData["fontScale"], string> = {
  small: "9px",
  medium: "10.5px",
  large: "12px",
};

/**
 * The issued document of the dev adapter (Issue #40): a mirror
 * of the server's print renderer over the adapter's own range,
 * so the publishing panel can be exercised by hand exactly as
 * against the real server. The audience rules are applied the
 * way getRange applies them on the server: a non-staff view's
 * document holds no staff-only events, no absences and no duty
 * names. The document is built once, at publish time, and the
 * stored string is what later reads return — later edits to the
 * fixture state do not reach it, as on the server.
 */
function buildDevDocument(input: {
  bootstrap: BootstrapData;
  view: ViewDefinitionData;
  range: RangeData;
  targetMonth: string;
  versionLabel: string;
  publishedAt: Date;
  settings: PrintSettingsData;
}): string {
  const { bootstrap, view, range, settings } = input;
  const staffView = view.audience === "staff";
  const columns = [...range.view.columns].sort((a, b) => a.sort - b.sort);
  const hasMovement = columns.some((c) => {
    const item = bootstrap.itemDefinitions.find((i) => i.id === c.itemDefinitionId);
    return c.sourceKind === "daily_item" && item?.key === "staff_movement";
  });
  const cellLines = (day: RangeDayData, column: (typeof columns)[number]): string[] => {
    if (column.sourceKind === "event_category") {
      return [
        ...day.events
          .filter((e) => staffView || e["visibility"] !== "staff_only")
          .filter((e) => !(hasMovement && provisionalTemplateOf(e, bootstrap)))
          .map((e) => `${eventTimeText(e)}${eventTitle(e)}`),
        ...(staffView ? day.absences.map((a) => absenceLineText(a, bootstrap)) : []),
      ];
    }
    if (column.sourceKind === "daily_item") {
      const item = bootstrap.itemDefinitions.find((i) => i.id === column.itemDefinitionId);
      if (item?.valueType === "event_list") {
        if (item.key === "staff_movement") {
          return [
            ...day.events
              .filter((e) => provisionalTemplateOf(e, bootstrap) !== null)
              .map((e) => provisionalLineText(e)),
            ...(staffView ? day.absences.map((a) => absenceLineText(a, bootstrap)) : []),
          ];
        }
        const bound =
          bootstrap.kindTemplates.find((t) => t.key === item.key || t.kindCode === item.key) ??
          null;
        if (bound?.subjectKind === "absence") {
          return [
            ...day.events
              .filter((e) => provisionalTemplateOf(e, bootstrap)?.key === bound.key)
              .map((e) => provisionalLineText(e)),
            ...(staffView
              ? day.absences
                  .filter((a) => a["kind"] === bound.kindCode)
                  .map((a) => absenceLineText(a, bootstrap))
              : []),
          ];
        }
        const kindCode = bound?.kindCode ?? "event";
        return day.events
          .filter((e) => e["kind"] === kindCode)
          .map((e) => `${eventTimeText(e)}${eventTitle(e)}`);
      }
      const text = dailyCellText(day, column, bootstrap);
      return text === "" ? [] : [text];
    }
    if (column.sourceKind === "duty") {
      if (!staffView) return [];
      return dutyCellLines(day, column, bootstrap, range.conflicts).map(
        (line) => `${line.text}${line.swapped ? "（交代）" : ""}`,
      );
    }
    const text = dayAttributeText(day);
    return text === "" ? [] : [text];
  };
  const monthText = `${input.targetMonth.slice(0, 4)}年${Number(input.targetMonth.slice(5, 7))}月`;
  const publishedText = input.publishedAt.toLocaleString("ja-JP");
  const head = columns
    .map((column) => `<th scope="col">${escHtml(columnLabel(column, bootstrap))}</th>`)
    .join("");
  const rowFor = (day: RangeDayData): string => {
    const mark = dayMark(day, bootstrap.masters.dayPatterns);
    const cells = columns
      .map(
        (column) =>
          `<td>${cellLines(day, column)
            .map((line) => `<div>${escHtml(line)}</div>`)
            .join("")}</td>`,
      )
      .join("");
    return `<tr${mark.closed ? ' class="closed"' : ""}><th scope="row" class="date-cell kind-${mark.kind}"><span class="date-num">${Number(day.date.slice(8, 10))}</span> <span class="date-weekday">（${weekdayLabel(day.date)}）</span>${mark.sub ? `<span class="date-sub">${escHtml(mark.sub)}</span>` : ""}</th>${cells}</tr>`;
  };
  const tableFor = (days: RangeDayData[]): string => `<table>
<thead><tr><th scope="col" class="date-cell">日</th>${head}</tr></thead>
<tbody>
${days.map(rowFor).join("\n")}
</tbody>
</table>`;
  // The two-column document (Issue #46), the server renderer's
  // shape: the month in two half tables side by side, headed by
  // the month's notes when the view carries them.
  const note = range.monthNotes.find((n) => n.month === input.targetMonth) ?? null;
  const monthNotesHtml =
    view.layout === "two_column" && note && (note.lifeGoal !== null || note.healthGoal !== null)
      ? `<section class="month-notes">${note.lifeGoal !== null ? `<div><span class="goal-label">生活目標</span> ${escHtml(note.lifeGoal)}</div>` : ""}${note.healthGoal !== null ? `<div><span class="goal-label">健康目標</span> ${escHtml(note.healthGoal)}</div>` : ""}</section>`
      : "";
  const tableSection =
    view.layout === "two_column"
      ? `<div class="two-column">${tableFor(range.days.slice(0, Math.ceil(range.days.length / 2)))}${tableFor(range.days.slice(Math.ceil(range.days.length / 2)))}</div>`
      : tableFor(range.days);
  const undecided = range.undecided.filter(
    (group) => group.month === input.targetMonth || group.month === null,
  );
  const undecidedHtml =
    undecided.length > 0
      ? `<section class="undecided"><h2>その月の未定</h2><ul>${undecided
          .flatMap((group) =>
            group.events.map(
              (event) =>
                `<li>${escHtml(eventTitle(event))}（${event["datePrecision"] === "undecided" ? "時期未定" : "月のみ確定"}）</li>`,
            ),
          )
          .join("")}</ul></section>`
      : "";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escHtml(bootstrap.school.name ?? "行事予定")} ${escHtml(monthText)} 行事予定表（${escHtml(input.versionLabel)}）</title>
<style>
@page {
  size: ${settings.paper} ${settings.orientation};
  margin: ${settings.marginMm}mm;
  @bottom-center { content: counter(page) " / " counter(pages); font-size: 9px; color: #555; }
}
body { font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans CJK JP", "Yu Gothic", sans-serif; font-size: ${PRINT_FONT_SIZES[settings.fontScale]}; color: #111; margin: 0; }
header.print-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 6px; }
header.print-head h1 { font-size: 1.5em; margin: 0; }
header.print-head .meta { text-align: right; white-space: nowrap; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #999; padding: 2px 4px; vertical-align: top; text-align: left; }
thead th { background: #eee; }
tr.closed { background: #f3f4f6; }
.date-cell { white-space: nowrap; width: 92px; }
.date-num { font-weight: 600; }
.kind-sat .date-num, .kind-sat .date-weekday { color: #2563eb; }
.kind-holiday .date-num, .kind-holiday .date-weekday { color: #b91c1c; }
.date-sub { display: block; font-size: 0.85em; color: #555; white-space: normal; }
section.undecided { margin-top: 10px; }
section.undecided h2 { font-size: 1.1em; margin: 0 0 4px; }
section.undecided ul { margin: 0; padding-left: 18px; }
.two-column { display: flex; gap: 12px; align-items: flex-start; }
.two-column table { flex: 1; }
section.month-notes { border: 1px solid #999; padding: 4px 8px; margin-bottom: 6px; }
section.month-notes .goal-label { font-weight: 600; margin-right: 8px; }
</style>
</head>
<body>
<header class="print-head">
<h1>${escHtml(bootstrap.school.name ?? "行事予定")} ${escHtml(monthText)} 行事予定表</h1>
<div class="meta"><div>${escHtml(view.name)}</div><div>版：${escHtml(input.versionLabel)}</div><div>発行：${escHtml(publishedText)}</div></div>
</header>
${monthNotesHtml}
${tableSection}
${undecidedHtml}
</body>
</html>
`;
}

export function createDevApi(): ScheduleApi {
  // The definition state of this adapter instance (Issue #39):
  // the settings screens edit these copies, and getBootstrap /
  // getRange read them back, so a saved setting is what the
  // table behind the panel is drawn from — the same contract as
  // the duty state below. The shared masters are kept in their
  // full platform record shape; the bootstrap's slimmer masters
  // are derived from them on every read.
  const boot = structuredClone(DEV_BOOTSTRAP);
  const locationsState: LocationData[] = [
    { id: "loc-gym", name: "体育館", kind: "屋内", sort: 1, isActive: true },
    { id: "loc-ground", name: "運動場", kind: "屋外", sort: 2, isActive: true },
    { id: "loc-music", name: "音楽室", kind: "特別教室", sort: 3, isActive: true },
  ];
  let settingsState: SchoolSettingsData = {
    inputOpener: "popover",
    dutyConflictAbsenceKinds: null,
  };
  const mastersState: MastersData = {
    staff: STAFF.map((s, i) => ({
      id: s.id,
      name: s.name,
      shortName: s.name.replace("先生", ""),
      sortOrder: i + 1,
      active: true,
      personId: i === 0 ? "dev-user" : null,
      revision: 1,
    })),
    grade: GRADES.map((g, i) => ({
      id: g.id,
      name: g.name,
      sortOrder: i + 1,
      stage: null,
      revision: 1,
    })),
    class: [
      { id: "class-1-1", gradeId: "grade-1", name: "1組", sortOrder: 1, revision: 1 },
      { id: "class-1-2", gradeId: "grade-1", name: "2組", sortOrder: 2, revision: 1 },
    ],
    special_needs_class: [{ id: "snc-1", name: "ひまわり", sortOrder: 1, revision: 1 }],
    day_pattern: [
      {
        id: "pattern-a",
        code: "A",
        name: "A日課",
        kind: "normal",
        periods: [
          { period: 1, label: "1限", startsAt: "08:45", endsAt: "09:35" },
          { period: 2, label: "2限", startsAt: "09:45", endsAt: "10:35" },
          { period: 3, label: "3限", startsAt: "10:45", endsAt: "11:35" },
          { period: 4, label: "4限", startsAt: "11:45", endsAt: "12:35" },
          { period: 5, label: "5限", startsAt: "13:30", endsAt: "14:20" },
          { period: 6, label: "6限", startsAt: "14:30", endsAt: "15:20" },
        ],
        revision: 1,
      },
    ],
  };

  // The platform's subdivision order (Issue #91): by kind,
  // then the school's sort, then key. The bootstrap's
  // subdivisions come from the platform's list on the real
  // path, so both reads sort the boot copy the same way.
  const subdivisionsInOrder = (): AbsenceSubdivisionData[] =>
    [...boot.absenceSubdivisions].sort((a, b) =>
      a.code === b.code ? a.sort - b.sort || (a.key < b.key ? -1 : 1) : a.code < b.code ? -1 : 1,
    );

  const bootstrapNow = (): BootstrapData =>
    structuredClone({
      ...boot,
      absenceSubdivisions: subdivisionsInOrder(),
      masters: {
        staff: mastersState.staff.map((s) => ({ id: String(s["id"]), name: String(s["name"]) })),
        grades: mastersState.grade.map((g) => ({ id: String(g["id"]), name: String(g["name"]) })),
        dayPatterns: mastersState.day_pattern.map((p) => ({
          id: String(p["id"]),
          code: String(p["code"]),
          name: String(p["name"]),
          // The pattern's periods ride along, as the platform
          // record carries them: the detail modal's 時限指定
          // offers them (Issue #37).
          periods: p["periods"],
        })),
      },
    });

  const definitionSetNow = (): DefinitionSetData => ({
    settings: structuredClone(settingsState),
    targetGroups: structuredClone(boot.targetGroups),
    itemDefinitions: structuredClone(boot.itemDefinitions),
    locations: structuredClone(locationsState),
  });

  // The duty state of this adapter instance (Issue #38): the
  // rotation's assignments by date, the recorded changes, and the
  // waived (assignment, absence) pairs. Panel operations rewrite
  // them, and every later read derives from them.
  const assignments = new Map<string, DutyAssignmentData>();
  const changes: DutyChangeData[] = [];
  const waivers = new Set<string>();
  let changeSeq = 0;

  // The issued publications of this adapter instance (Issue
  // #40): the version records, newest first, and their stored
  // documents by id. A document is built once at publish time
  // and never rebuilt, as on the server.
  const publications: PublicationData[] = [];
  const publicationDocuments = new Map<string, string>();
  let publicationSeq = 0;

  // The views' month notes of this adapter instance (Issue
  // #46): keyed by view and month, seeded with the student
  // preset's November note, and rewritten by setViewMonthNote —
  // getRange reads back what was written, as on the server.
  const monthNotes = new Map<string, ViewMonthNoteData>();
  monthNotes.set("view-month-student|2026-11", {
    month: "2026-11",
    lifeGoal: "あいさつを自分からしよう",
    healthGoal: "早寝・早起き・朝ごはん",
  });
  const monthNotesFor = (viewId: string, from: string, to: string): ViewMonthNoteData[] => {
    const fromMonth = from.slice(0, 7);
    const toMonth = to.slice(0, 7);
    const found: ViewMonthNoteData[] = [];
    for (const [key, note] of monthNotes) {
      if (!key.startsWith(`${viewId}|`)) continue;
      if (fromMonth <= note.month && note.month <= toMonth) found.push({ ...note });
    }
    return found.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  };

  // The fixture world's one duty and its stop switch (Issue
  // #86): while 日番 is stopped, no new rotation assignments
  // appear and no "unassigned" conflicts are derived — the same
  // results the server gives. Standing assignments stay.
  const dutyDayActive = (): boolean =>
    boot.dutyDefinitions.find((d) => d.id === "duty-day")?.isActive !== false;

  const ensureAssignment = (date: string): DutyAssignmentData | null => {
    if (!isClassDay(date)) return null;
    const existing = assignments.get(date);
    if (existing) return existing;
    if (!dutyDayActive()) return null;
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
      if (dutyDayActive() && isClassDay(date) && !assignment) {
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
      // Club activities (Issue #45): a fixed weekly pattern per
      // club, so the transposed table's rows read differently —
      // baseball practises Mon/Wed/Fri, soccer starts Monday
      // mornings only, the brass band meets on Fridays.
      const clubPlan: Record<string, Record<string, string>> = {
        "tgt-club-baseball": {
          mon: "practice",
          tue: "off",
          wed: "practice",
          thu: "off",
          fri: "practice",
        },
        "tgt-club-soccer": {
          mon: "morning",
          tue: "practice",
          wed: "off",
          thu: "practice",
          fri: "off",
        },
        "tgt-club-brass": {
          mon: "practice",
          tue: "practice",
          wed: "practice",
          thu: "practice",
          fri: "meeting",
        },
      };
      for (const [targetId, byWeekday] of Object.entries(clubPlan)) {
        const code = byWeekday[weekday];
        if (code) {
          dailyValues.push(
            value({
              date,
              itemDefinitionId: "item-club-activity",
              targetId,
              valueOptionId: `opt-club-activity-${code}`,
            }),
          );
        }
      }
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
      ...TIMED_EVENTS.map((e, i) => fixtureEvent(e.date, e.title, 100 + i, e.time, "guardian")),
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
  const devRange = async (input: {
    from: string;
    to: string;
    viewId: string;
  }): Promise<RangeData> => {
    const view =
      boot.views.find((v) => v.id === input.viewId) ?? (boot.views[0] as ViewDefinitionData);
    const dates = datesInRange(input.from, input.to);
    valueSeq = 0;
    const fullDays = dates.map((date) => {
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
    });
    const fullUndecided: RangeData["undecided"] = [
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
    ];
    // A view's range is shaped the way the server shapes it
    // (schedule/src/range/actions.ts, over the platform's own
    // event filter): the columns and daily items are the
    // audience whitelist of @school-manage/calendar-types
    // (audienceColumns / audienceItems — duty columns and
    // staff-only items never reach a non-staff audience, and
    // an item reaches only as far as its defaultVisibility
    // says), the events are the platform filter's (isVisibleTo,
    // shaped nameless for a non-staff audience), and absences,
    // duty assignments and conflicts are staff dynamics that
    // never leave the staff views. The student table (Issue
    // #46) reads exactly this bundle. For a staff view every
    // one of these is the identity, as on the server.
    const staffView = view.audience === "staff";
    const rank = viewAudienceRank(view.audience as Audience);
    const itemSlices = boot.itemDefinitions.map((i) => ({
      id: i.id,
      defaultVisibility: i.defaultVisibility as Visibility,
    }));
    const keptColumns = audienceColumns(view.columns, itemSlices, rank);
    const keptItemIds = new Set(audienceItems(itemSlices, keptColumns, rank).map((i) => i.id));
    const publicEvent = (e: Record<string, unknown>): Record<string, unknown> => {
      const shaped: Record<string, unknown> = { ...e, assignees: [] };
      delete shaped["createdBy"];
      delete shaped["updatedBy"];
      return shaped;
    };
    const shapeEvents = (events: Record<string, unknown>[]): Record<string, unknown>[] =>
      events
        .filter((e) => isVisibleTo(e["visibility"] as Visibility, view.audience as Audience))
        .map((e) => (staffView ? e : publicEvent(e)));
    const days = fullDays.map((day) => ({
      ...day,
      events: shapeEvents(day.events),
      absences: staffView ? day.absences : [],
      dutyAssignments: staffView ? day.dutyAssignments : [],
      dailyValues: day.dailyValues.filter((v) => keptItemIds.has(v.itemDefinitionId)),
    }));
    const undecided = fullUndecided.map((group) => ({
      ...group,
      events: shapeEvents(group.events),
    }));
    return {
      view: structuredClone({ ...view, columns: keptColumns }),
      from: input.from,
      to: input.to,
      days,
      undecided,
      eventValues: [],
      conflicts: staffView ? deriveConflicts(input.from, input.to) : [],
      monthNotes: monthNotesFor(view.id, input.from, input.to),
    } satisfies RangeData;
  };

  return {
    async getBootstrap() {
      return bootstrapNow();
    },
    async getRange(input) {
      return devRange(input);
    },
    async createEvent(input): Promise<RelaySaveResult> {
      const record: Record<string, unknown> = { ...input.event, revision: 1 };
      // The platform keeps the confirmation stamps consistent
      // with the certainty (Issue #85); the dev adapter answers
      // the same way instead of trusting what the form sent.
      if (record["certainty"] === "confirmed") {
        record["confirmedBy"] = "dev-user";
        record["confirmedAt"] = new Date().toISOString();
      } else {
        record["confirmedBy"] = null;
        record["confirmedAt"] = null;
      }
      state.events.push(record);
      return { record, values: [] };
    },
    async updateEvent(input): Promise<RelaySaveResult> {
      const index = state.events.findIndex((e) => e["id"] === input.id);
      if (index < 0) throw new Error(`event not found: ${input.id}`);
      const existing = state.events[index] as Record<string, unknown>;
      const record: Record<string, unknown> = {
        ...input.event,
        id: input.id,
        revision: input.revision + 1,
      };
      if (record["certainty"] === "confirmed") {
        if (existing["certainty"] === "confirmed" && existing["confirmedBy"]) {
          record["confirmedBy"] = existing["confirmedBy"];
          record["confirmedAt"] = existing["confirmedAt"];
        } else {
          record["confirmedBy"] = "dev-user";
          record["confirmedAt"] = new Date().toISOString();
        }
      } else {
        record["confirmedBy"] = null;
        record["confirmedAt"] = null;
      }
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
      const itemDef = boot.itemDefinitions.find((i) => i.id === input.itemDefinitionId);
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
      // A stopped duty generates nothing (Issue #86), as on the
      // server: the preview refuses rather than planning cells
      // the apply would never write.
      if (!dutyDayActive()) {
        throw new Error(`duty definition is not active: ${input.dutyDefinitionId}`);
      }
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
      if (!dutyDayActive()) {
        throw new Error(`duty definition is not active: ${input.dutyDefinitionId}`);
      }
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

    // --- Issue #39: the settings screens and the queue ---------

    async getDefinitions() {
      return definitionSetNow();
    },

    async upsertItemDefinition(input) {
      const saved: ItemDefinitionData = {
        id: String(input["id"]),
        key: String(input["key"]),
        name: String(input["name"]),
        valueType: String(input["valueType"]),
        targetGroupId: (input["targetGroupId"] as string | null) ?? null,
        targetPlatformAxis: (input["targetPlatformAxis"] as string | null) ?? null,
        granularity: String(input["granularity"]),
        defaultVisibility: String(input["defaultVisibility"]),
        isActive: input["isActive"] !== false,
        sort: typeof input["sort"] === "number" ? (input["sort"] as number) : 0,
        options: ((input["options"] as ItemDefinitionData["options"] | undefined) ?? []).map(
          (o) => ({ ...o }),
        ),
      };
      boot.itemDefinitions = [...boot.itemDefinitions.filter((i) => i.id !== saved.id), saved].sort(
        (a, b) => a.sort - b.sort,
      );
      return structuredClone(saved);
    },

    async deleteItemDefinition(input) {
      // The server refuses with a 409 when a view column still
      // uses the item, naming the views (Issue #88); the refusal
      // reaches the screen as-is here too.
      const usedByNames = [
        ...new Set(
          boot.views
            .filter((v) => v.columns.some((c) => c.itemDefinitionId === input.id))
            .map((v) => v.name),
        ),
      ].sort();
      if (usedByNames.length > 0) {
        throw new Error(
          `この項目はビューで使われているので削除できません（使われているビュー：${usedByNames.join("、")}）`,
        );
      }
      boot.itemDefinitions = boot.itemDefinitions.filter((i) => i.id !== input.id);
      return { deleted: true as const };
    },

    async upsertTargetGroup(input) {
      const existing = boot.targetGroups.find((g) => g.id === input["id"]);
      const saved = {
        id: String(input["id"]),
        key: String(input["key"]),
        name: String(input["name"]),
        sort: typeof input["sort"] === "number" ? (input["sort"] as number) : 0,
        targets: existing?.targets ?? [],
      };
      boot.targetGroups = [...boot.targetGroups.filter((g) => g.id !== saved.id), saved].sort(
        (a, b) => a.sort - b.sort,
      );
      return structuredClone(saved);
    },

    async deleteTargetGroup(input) {
      boot.targetGroups = boot.targetGroups.filter((g) => g.id !== input.id);
      return { deleted: true as const };
    },

    async upsertTarget(input) {
      const group = boot.targetGroups.find((g) => g.id === input["targetGroupId"]);
      if (!group) throw new Error(`target group not found: ${String(input["targetGroupId"])}`);
      const saved = {
        id: String(input["id"]),
        targetGroupId: group.id,
        code: (input["code"] as string | null) ?? null,
        name: String(input["name"]),
        sort: typeof input["sort"] === "number" ? (input["sort"] as number) : 0,
      };
      group.targets = [...group.targets.filter((t) => t.id !== saved.id), saved].sort(
        (a, b) => a.sort - b.sort,
      );
      return structuredClone(saved);
    },

    async deleteTarget(input) {
      for (const group of boot.targetGroups) {
        group.targets = group.targets.filter((t) => t.id !== input.id);
      }
      return { deleted: true as const };
    },

    async upsertLocation(input) {
      const saved: LocationData = {
        id: String(input["id"]),
        name: String(input["name"]),
        kind: (input["kind"] as string | null) ?? null,
        sort: typeof input["sort"] === "number" ? (input["sort"] as number) : 0,
        isActive: input["isActive"] !== false,
      };
      const index = locationsState.findIndex((l) => l.id === saved.id);
      if (index >= 0) locationsState[index] = saved;
      else locationsState.push(saved);
      locationsState.sort((a, b) => a.sort - b.sort);
      return structuredClone(saved);
    },

    async deleteLocation(input) {
      const index = locationsState.findIndex((l) => l.id === input.id);
      if (index >= 0) locationsState.splice(index, 1);
      return { deleted: true as const };
    },

    async saveSettings(input) {
      settingsState = {
        inputOpener: input.inputOpener,
        dutyConflictAbsenceKinds:
          input.dutyConflictAbsenceKinds !== undefined
            ? input.dutyConflictAbsenceKinds
            : settingsState.dutyConflictAbsenceKinds,
      };
      return structuredClone(settingsState);
    },

    async applyPreset(input) {
      // The fixture school already carries the elementary-bus
      // preset, so — as on the real store, which skips keys the
      // school already has — the elementary presets change
      // nothing here. The junior-high preset adds its signature
      // club items and axis when they are missing; the axis
      // ships without targets, as the server's preset ships it
      // (schedule/src/definitions/presets.ts) — the school adds
      // its own clubs as targets.
      if (input.preset === "junior_high") {
        if (!boot.targetGroups.some((g) => g.key === "club")) {
          boot.targetGroups.push({
            id: "tg-club",
            key: "club",
            name: "部活動",
            sort: 2,
            targets: [],
          });
        }
        // The preset's two club items, as the server's preset
        // ships them: the whole-school 部活動 and the per-club
        // 部活動（部別）whose axis the transposed table rows on.
        if (!boot.itemDefinitions.some((i) => i.key === "club_day")) {
          boot.itemDefinitions.push(
            item("item-club-day", "club_day", "部活動", "symbol", 9, {
              options: clubOptions("club-day"),
            }),
          );
        }
        if (!boot.itemDefinitions.some((i) => i.key === "club_activity")) {
          boot.itemDefinitions.push(
            item("item-club-activity", "club_activity", "部活動（部別）", "symbol", 10, {
              targetGroupId: "tg-club",
              defaultVisibility: "staff_only",
              options: clubOptions("club-activity"),
            }),
          );
        }
      }
      return definitionSetNow();
    },

    async upsertViewDefinition(input) {
      const viewId = String(input["id"]);
      const saved: ViewDefinitionData = {
        id: viewId,
        name: String(input["name"]),
        layout: String(input["layout"]),
        layoutParams: (input["layoutParams"] as Record<string, unknown> | null) ?? null,
        audience: String(input["audience"]),
        periodScope: String(input["periodScope"]),
        printSettings: (input["printSettings"] as Record<string, unknown> | null) ?? null,
        // An edit never touches the archived flag, as on the
        // server: only setViewArchived moves a view off the list
        // or back onto it (Issue #87).
        isArchived: boot.views.find((v) => v.id === viewId)?.isArchived ?? false,
        columns: ((input["columns"] as ViewDefinitionData["columns"] | undefined) ?? []).map(
          (c) => ({ ...c, viewDefinitionId: viewId }),
        ),
      };
      boot.views = [...boot.views.filter((v) => v.id !== saved.id), saved];
      return structuredClone(saved);
    },

    async deleteViewDefinition(input) {
      // The server refuses with a 409 when the view has issued
      // publications (the versions must keep naming their view);
      // the refusal names archiving as the way to retire the
      // view instead (Issue #87).
      if (publications.some((p) => p.viewDefinitionId === input.id)) {
        throw new Error("発行した版があるビューは削除できません。一覧から外すことはできます");
      }
      boot.views = boot.views.filter((v) => v.id !== input.id);
      return { deleted: true as const };
    },

    async setViewArchived(input) {
      const view = boot.views.find((v) => v.id === input.id);
      if (!view) throw new Error(`view definition not found: ${input.id}`);
      view.isArchived = input.archived;
      return structuredClone(view);
    },

    // A view's month notes (Issue #46): the write lands in the
    // adapter's note store, and the next getRange for that view
    // and month reads it back — the server's contract, with the
    // same normalisation (a blank goal is no goal).
    async setViewMonthNote(input) {
      const view = boot.views.find((v) => v.id === input.viewId);
      if (!view) throw new Error(`view definition not found: ${input.viewId}`);
      const goal = (text: string | null): string | null => {
        const trimmed = text?.trim() ?? "";
        return trimmed === "" ? null : trimmed;
      };
      const note: ViewMonthNoteData = {
        month: input.month,
        lifeGoal: goal(input.lifeGoal),
        healthGoal: goal(input.healthGoal),
      };
      monthNotes.set(`${input.viewId}|${input.month}`, note);
      return structuredClone(note);
    },

    async upsertDutyDefinition(input) {
      const saved = {
        id: String(input["id"]),
        name: String(input["name"]),
        granularity: String(input["granularity"]),
        applicablePeriod: String(input["applicablePeriod"]),
        applicableStartsOn: (input["applicableStartsOn"] as string | null) ?? null,
        applicableEndsOn: (input["applicableEndsOn"] as string | null) ?? null,
        targetGroupId: (input["targetGroupId"] as string | null) ?? null,
        sort: typeof input["sort"] === "number" ? (input["sort"] as number) : 0,
        isActive: input["isActive"] !== false,
        rotation:
          (input["rotation"] as { personIds: string[]; changeWeekdays: string[] | null } | null) ??
          null,
      };
      boot.dutyDefinitions = [...boot.dutyDefinitions.filter((d) => d.id !== saved.id), saved].sort(
        (a, b) => a.sort - b.sort,
      );
      return structuredClone(saved);
    },

    async deleteDutyDefinition(input) {
      boot.dutyDefinitions = boot.dutyDefinitions.filter((d) => d.id !== input.id);
      return { deleted: true as const };
    },

    async upsertKindTemplate(input) {
      const saved = {
        id: String(input["id"]),
        key: String(input["key"]),
        name: String(input["name"]),
        subjectKind: String(input["subjectKind"]) as "event" | "absence",
        kindCode: String(input["kindCode"]),
        personLabel: String(input["personLabel"]),
        displaySource: String(input["displaySource"]) as "title" | "person" | "person_title",
        steps: ((input["steps"] as { kind: string; itemDefinitionId?: string | null }[]) ?? []).map(
          (s) => ({ kind: s.kind, itemDefinitionId: s.itemDefinitionId ?? null }),
        ),
        itemDefinitionIds: (input["itemDefinitionIds"] as string[] | undefined) ?? [],
        sort: typeof input["sort"] === "number" ? (input["sort"] as number) : 0,
      };
      boot.kindTemplates = [...boot.kindTemplates.filter((t) => t.id !== saved.id), saved].sort(
        (a, b) => a.sort - b.sort,
      );
      return structuredClone(saved);
    },

    async deleteKindTemplate(input) {
      boot.kindTemplates = boot.kindTemplates.filter((t) => t.id !== input.id);
      return { deleted: true as const };
    },

    async applyDefaultKindTemplates() {
      return structuredClone(boot.kindTemplates);
    },

    async getMasters() {
      return structuredClone(mastersState);
    },

    async createMaster(input) {
      const record = { ...input.record, revision: 1 };
      (mastersState[input.kind] as Record<string, unknown>[]).push(record);
      return structuredClone(record);
    },

    async updateMaster(input) {
      const list = mastersState[input.kind] as Record<string, unknown>[];
      const index = list.findIndex((r) => r["id"] === input.id);
      if (index < 0) throw new Error(`master not found: ${input.id}`);
      const record = { ...input.record, revision: (list[index]?.["revision"] as number) + 1 };
      list[index] = record;
      return structuredClone(record);
    },

    async deleteMaster(input) {
      const list = mastersState[input.kind] as Record<string, unknown>[];
      const index = list.findIndex((r) => r["id"] === input.id);
      if (index >= 0) list.splice(index, 1);
      return { deleted: true as const };
    },

    // The absence subdivisions (Issue #84): the settings screen
    // maintains the boot copy, and getBootstrap reads it back, so
    // a saved classification is what the absence modal offers —
    // the same contract as the masters above. The platform's
    // verdicts are mirrored in its wordings: a duplicate key, a
    // key change on an existing classification, and a
    // classification an absence still uses are refused, with
    // the relay's sentences.
    async getSubdivisions() {
      return { items: structuredClone(subdivisionsInOrder()) };
    },

    async createSubdivision(input) {
      if (
        boot.absenceSubdivisions.some(
          (s) =>
            s.id === input.record.id ||
            (s.code === input.record.code && s.key === input.record.key),
        )
      ) {
        throw new Error("同じ種類で同じキーの分類がすでにあります");
      }
      // A create that names no sort goes after its kind's
      // current entries, as on the platform.
      const sort =
        input.record.sort ??
        boot.absenceSubdivisions
          .filter((s) => s.code === input.record.code)
          .reduce((max, s) => Math.max(max, s.sort), 0) + 10;
      const record = { ...input.record, sort, revision: 1 };
      boot.absenceSubdivisions.push(record);
      return structuredClone(record);
    },

    async updateSubdivision(input) {
      const index = boot.absenceSubdivisions.findIndex((s) => s.id === input.id);
      if (index < 0) throw new Error(`subdivision not found: ${input.id}`);
      const existing = boot.absenceSubdivisions[index] as AbsenceSubdivisionData;
      if (input.record.revision !== existing.revision) {
        throw new Error("ほかの人が先に変更しました");
      }
      if (input.record.code !== existing.code || input.record.key !== existing.key) {
        throw new Error("すでにある分類のキーは変更できません");
      }
      if (
        boot.absenceSubdivisions.some(
          (s) => s.id !== input.id && s.code === input.record.code && s.key === input.record.key,
        )
      ) {
        throw new Error("同じ種類で同じキーの分類がすでにあります");
      }
      // The stored record is the base: a field the update does
      // not name — the sort, when a rename sends none — keeps
      // its stored value, as on the platform (Issue #91).
      const record = { ...existing, ...input.record, revision: existing.revision + 1 };
      boot.absenceSubdivisions[index] = record;
      return structuredClone(record);
    },

    async deleteSubdivision(input) {
      const record = boot.absenceSubdivisions.find((s) => s.id === input.id);
      if (!record) throw new Error(`subdivision not found: ${input.id}`);
      if (input.revision !== record.revision) {
        throw new Error("ほかの人が先に変更しました");
      }
      const inUse = state.absences.some(
        (a) => a["kind"] === record.code && a["subdivisionKey"] === record.key,
      );
      if (inUse) {
        throw new Error("この分類は不在で使われているため削除できません");
      }
      boot.absenceSubdivisions = boot.absenceSubdivisions.filter((s) => s.id !== input.id);
      return { deleted: true as const };
    },

    async applyDefaultSubdivisions() {
      // The platform's defaults, with their apply-defaults sort
      // values (Issue #91), in the order the platform's list
      // defines them.
      const defaults: [string, string, number][] = [
        ["annual", "年休", 10],
        ["sick", "病休", 40],
        ["special", "特休", 20],
        ["summer_special", "夏特", 30],
        ["nursing", "看護", 50],
        ["duty_exempt", "職専免", 70],
        ["compensatory", "振休", 60],
        ["other", "その他", 80],
      ];
      const created: AbsenceSubdivisionData[] = [];
      for (const [key, label, sort] of defaults) {
        if (boot.absenceSubdivisions.some((s) => s.code === "leave" && s.key === key)) continue;
        const record: AbsenceSubdivisionData = {
          id: `subdiv-leave-${key}`,
          code: "leave",
          key,
          label,
          sort,
          revision: 1,
        };
        boot.absenceSubdivisions.push(record);
        created.push(record);
      }
      return { items: structuredClone(created) };
    },

    async getPendingAbsences() {
      return {
        items: structuredClone(state.absences.filter((a) => a["certainty"] === "tentative")),
      };
    },

    async confirmAbsence(input) {
      const absence = state.absences.find((a) => a["id"] === input.id);
      if (!absence) throw new Error(`absence not found: ${input.id}`);
      absence["certainty"] = "confirmed";
      absence["confirmedBy"] = "dev-user";
      absence["revision"] = (absence["revision"] as number) + 1;
      return structuredClone(absence);
    },

    async getPendingEvents(input) {
      return {
        items: structuredClone(
          state.events.filter(
            (e) =>
              e["certainty"] === "tentative" &&
              typeof e["startsOn"] === "string" &&
              typeof e["endsOn"] === "string" &&
              (e["startsOn"] as string) <= input.to &&
              input.from <= (e["endsOn"] as string),
          ),
        ),
      };
    },

    async confirmEvent(input) {
      const event = state.events.find((e) => e["id"] === input.id);
      if (!event) throw new Error(`event not found: ${input.id}`);
      event["certainty"] = "confirmed";
      // The platform stamps the confirmer and the moment
      // (Issue #85); the dev adapter answers the same way.
      event["confirmedBy"] = "dev-user";
      event["confirmedAt"] = new Date().toISOString();
      event["revision"] = (event["revision"] as number) + 1;
      return structuredClone(event);
    },

    // --- Issue #40: publishing -------------------------------

    async createPublication(input) {
      const view = boot.views.find((v) => v.id === input.viewId);
      if (!view) throw new Error(`view definition not found: ${input.viewId}`);
      const settings = resolveDevPrintSettings(view.printSettings, input.printSettings);
      const anchor = `${input.targetMonth}-15`;
      const range = await devRange({
        from: monthStartOf(anchor),
        to: monthEndOf(anchor),
        viewId: view.id,
      });
      const publishedAt = new Date();
      const documentHtml = buildDevDocument({
        bootstrap: bootstrapNow(),
        view,
        range,
        targetMonth: input.targetMonth,
        versionLabel: input.versionLabel,
        publishedAt,
        settings,
      });
      publicationSeq += 1;
      const publication: PublicationData = {
        id: `pub-${publicationSeq}`,
        viewDefinitionId: view.id,
        targetMonth: input.targetMonth,
        versionLabel: input.versionLabel,
        publishedAt: publishedAt.toISOString(),
        publishedBy: "dev-user",
        snapshotNote: input.note ?? null,
        printSettings: settings,
        documentFormat: "html",
      };
      publications.unshift(publication);
      publicationDocuments.set(publication.id, documentHtml);
      return structuredClone(publication);
    },

    async getPublications(input) {
      return structuredClone(
        publications.filter((p) => !input?.viewId || p.viewDefinitionId === input.viewId),
      );
    },

    async getPublication(input) {
      const publication = publications.find((p) => p.id === input.id);
      if (!publication) throw new Error(`publication not found: ${input.id}`);
      return {
        ...structuredClone(publication),
        documentHtml: publicationDocuments.get(publication.id) ?? "",
      };
    },

    // Issue #41: public-view tokens, over the shared fixture
    // store below (the settings screen and the public screen
    // read the same rows, as they would on the server).
    async createPublicViewToken(input) {
      const view = boot.views.find((v) => v.id === input.viewId);
      if (!view) throw new Error(`view definition not found: ${input.viewId}`);
      if (view.audience === "staff") {
        throw new ApiError(400, "職員用ビューには公開URLを発行できません");
      }
      const tokens = loadDevPublicTokens();
      devPublicTokenSeq += 1;
      const row: DevPublicToken = {
        id: `ptok-${devPublicTokenSeq}`,
        viewDefinitionId: view.id,
        createdBy: "dev-user",
        createdAt: new Date().toISOString(),
        revokedAt: null,
        token: `dev-${Math.random().toString(36).slice(2, 10)}${Math.random()
          .toString(36)
          .slice(2, 10)}`,
      };
      tokens.push(row);
      saveDevPublicTokens();
      return { ...publicTokenRow(row), token: row.token };
    },

    async getPublicViewTokens(input) {
      return loadDevPublicTokens()
        .filter((t) => !input?.viewId || t.viewDefinitionId === input.viewId)
        .map(publicTokenRow);
    },

    async revokePublicViewToken(input) {
      const tokens = loadDevPublicTokens();
      const row = tokens.find((t) => t.id === input.id);
      if (!row) throw new Error(`public view token not found: ${input.id}`);
      if (!row.revokedAt) {
        row.revokedAt = new Date().toISOString();
        saveDevPublicTokens();
      }
      return publicTokenRow(row);
    },
  };
}

// ---- public-view tokens (Issue #41, dev fixtures) ----------------
//
// The fixture store for the token actions above and the public
// screen below. Unlike the server — which keeps only each
// token's hash — the adapter must keep the value itself to
// resolve the URLs it is asked to open; that is fixture data
// only, and it lives in sessionStorage so a token issued on the
// settings screen still opens after the page reloads to the
// public URL (the two screens are separate page loads). One
// token comes pre-issued for the guardian view, value
// "dev-public-token", so the public screen can be opened
// directly: /{slug}/schedule/public-view/dev-public-token?dev=1.
interface DevPublicToken extends PublicViewTokenData {
  token: string;
}

const DEV_PUBLIC_TOKENS_KEY = "schedule-dev-public-tokens";
let devPublicTokens: DevPublicToken[] | null = null;
let devPublicTokenSeq = 1;

function loadDevPublicTokens(): DevPublicToken[] {
  if (devPublicTokens) return devPublicTokens;
  let rows: DevPublicToken[] | null = null;
  try {
    const raw = sessionStorage.getItem(DEV_PUBLIC_TOKENS_KEY);
    if (raw) rows = JSON.parse(raw) as DevPublicToken[];
  } catch {
    rows = null;
  }
  devPublicTokens = rows ?? [
    {
      id: "ptok-fixture",
      viewDefinitionId: "view-month-guardian",
      createdBy: "dev-user",
      createdAt: "2026-11-01T09:00:00.000Z",
      revokedAt: null,
      token: "dev-public-token",
    },
  ];
  return devPublicTokens;
}

function saveDevPublicTokens(): void {
  try {
    sessionStorage.setItem(DEV_PUBLIC_TOKENS_KEY, JSON.stringify(devPublicTokens));
  } catch {
    // Storage can be unavailable (private mode, tests); the
    // in-memory rows still serve this page.
  }
}

function publicTokenRow(row: DevPublicToken): PublicViewTokenData {
  return {
    id: row.id,
    viewDefinitionId: row.viewDefinitionId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

/** The development adapter's public client (Issue #41): the
 *  token is resolved against the fixture store, and the answers
 *  are the dev bootstrap / range shaped the way the server's
 *  public actions shape them — the view's audience filter over
 *  the events, and no absences, duties, conflicts or person ids
 *  anywhere. */
export function createDevPublicApi(tokenValue: string): PublicApi {
  const inner = createDevApi();
  const resolve = (): DevPublicToken => {
    const row = loadDevPublicTokens().find((t) => t.token === tokenValue);
    if (!row) throw new ApiError(404, "公開URLが見つかりません");
    if (row.revokedAt) throw new UnauthorizedError("この公開URLは無効化されています");
    return row;
  };
  const publicEvent = (event: Record<string, unknown>): Record<string, unknown> => {
    const shaped: Record<string, unknown> = { ...event, assignees: [] };
    delete shaped["createdBy"];
    delete shaped["updatedBy"];
    return shaped;
  };
  return {
    async getPublicBootstrap(): Promise<PublicBootstrapData> {
      const row = resolve();
      const boot = await inner.getBootstrap();
      const view =
        boot.views.find((v) => v.id === row.viewDefinitionId) ??
        (boot.views[0] as ViewDefinitionData);
      const itemIds = new Set(
        view.columns
          .filter((c) => c.sourceKind === "daily_item" && c.itemDefinitionId)
          .map((c) => c.itemDefinitionId as string),
      );
      const itemDefinitions = boot.itemDefinitions.filter((i) => itemIds.has(i.id));
      const groupIds = new Set<string>();
      for (const column of view.columns) {
        if (column.targetGroupId) groupIds.add(column.targetGroupId);
      }
      for (const item of itemDefinitions) {
        if (item.targetGroupId) groupIds.add(item.targetGroupId);
      }
      return {
        school: { id: boot.school.id, name: boot.school.name ?? "学校" },
        view: structuredClone(view),
        itemDefinitions: structuredClone(itemDefinitions),
        targetGroups: structuredClone(boot.targetGroups.filter((g) => groupIds.has(g.id))),
        grades: structuredClone(boot.masters.grades),
        holidays: Object.entries(HOLIDAYS).map(([date, name]) => ({
          id: `hol-${date}`,
          date,
          name,
          kind: "national_holiday",
        })),
      };
    },

    async getPublicRange(input): Promise<RangeData> {
      const row = resolve();
      const boot = await inner.getBootstrap();
      const view =
        boot.views.find((v) => v.id === row.viewDefinitionId) ??
        (boot.views[0] as ViewDefinitionData);
      const range = await inner.getRange({ ...input, viewId: view.id });
      const itemIds = new Set(
        view.columns
          .filter((c) => c.sourceKind === "daily_item" && c.itemDefinitionId)
          .map((c) => c.itemDefinitionId as string),
      );
      const visible = (e: Record<string, unknown>) => e["visibility"] !== "staff_only";
      return {
        ...range,
        days: range.days.map((day) => ({
          ...day,
          events: day.events.filter(visible).map((e) => publicEvent(e)),
          absences: [],
          dutyAssignments: [],
          dailyValues: day.dailyValues
            .filter((v) => itemIds.has(v.itemDefinitionId))
            .map((v) => ({ ...v, valuePersonId: null })),
        })),
        undecided: range.undecided.map((group) => ({
          ...group,
          events: group.events.filter(visible).map((e) => publicEvent(e)),
        })),
        eventValues: [],
        conflicts: [],
      };
    },
  };
}

/** The dev adapter's print-settings resolution: the DESIGN
 *  9.1 defaults, the view's own print_settings over them, then
 *  the publisher's choices — the server's order. */
function resolveDevPrintSettings(
  viewSettings: Record<string, unknown> | null,
  override?: Partial<PrintSettingsData>,
): PrintSettingsData {
  const resolved: PrintSettingsData = {
    paper: "A4",
    orientation: "landscape",
    marginMm: 10,
    fontScale: "medium",
  };
  if (viewSettings) {
    if (viewSettings["paper"] === "A4" || viewSettings["paper"] === "A3") {
      resolved.paper = viewSettings["paper"];
    }
    if (viewSettings["orientation"] === "landscape" || viewSettings["orientation"] === "portrait") {
      resolved.orientation = viewSettings["orientation"];
    }
    if (typeof viewSettings["marginMm"] === "number") resolved.marginMm = viewSettings["marginMm"];
    if (
      viewSettings["fontScale"] === "small" ||
      viewSettings["fontScale"] === "medium" ||
      viewSettings["fontScale"] === "large"
    ) {
      resolved.fontScale = viewSettings["fontScale"];
    }
  }
  return { ...resolved, ...(override ?? {}) };
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
