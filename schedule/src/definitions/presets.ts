import type { ItemDefinitionInput, PresetKey, TargetGroupInput, TargetInput } from "./types.js";

/**
 * The three Phase 1 presets (DESIGN schedule 5.1 and 12): elementary
 * without a school bus, elementary with a school bus, and junior
 * high. A preset is only a starting point: applying one inserts what
 * is missing and never overwrites a definition the school already
 * has (Issue #27). Duty definitions named in 5.1 (日番・日直・週番)
 * are not here; they arrive with the duty issue.
 *
 * Ids are deterministic so a re-application finds the same rows.
 * Grades are not a target group: items that vary by grade point at
 * the platform axis instead (DESIGN-INTEGRATION 2.4).
 */
export interface PresetTargetGroup {
  group: TargetGroupInput;
  targets: TargetInput[];
}

export interface Preset {
  key: PresetKey;
  targetGroups: PresetTargetGroup[];
  itemDefinitions: ItemDefinitionInput[];
}

const yesNoOptions = (itemKey: string, yesMeaning: string, noMeaning: string) => [
  { id: `opt-${itemKey}-yes`, code: "yes", label: "○", meaning: yesMeaning, sort: 1 },
  { id: `opt-${itemKey}-no`, code: "no", label: "×", meaning: noMeaning, sort: 2 },
];

const lunchItem: ItemDefinitionInput = {
  id: "item-lunch",
  key: "lunch",
  name: "給食",
  valueType: "symbol",
  granularity: "day",
  defaultVisibility: "guardian",
  isAggregatable: true,
  sort: 2,
  options: [
    {
      id: "opt-lunch-yes",
      code: "yes",
      label: "○",
      meaning: "給食がある日",
      countsAs: { lunch_day: true },
      sort: 1,
    },
    {
      id: "opt-lunch-no",
      code: "no",
      label: "×",
      meaning: "給食がない日",
      countsAs: { lunch_day: false },
      sort: 2,
    },
  ],
};

const eventsItem: ItemDefinitionInput = {
  id: "item-events",
  key: "events",
  name: "行事",
  valueType: "event_list",
  granularity: "day",
  defaultVisibility: "guardian",
  sort: 1,
};

const dismissalItem: ItemDefinitionInput = {
  id: "item-dismissal",
  key: "dismissal",
  name: "下校時刻",
  valueType: "time",
  targetPlatformAxis: "grade",
  granularity: "day",
  defaultVisibility: "guardian",
  sort: 3,
};

const clubOptions = (itemKey: string) => [
  { id: `opt-${itemKey}-practice`, code: "practice", label: "練", meaning: "通常練習", sort: 1 },
  { id: `opt-${itemKey}-off`, code: "off", label: "休", meaning: "休み", sort: 2 },
  { id: `opt-${itemKey}-tournament`, code: "tournament", label: "大", meaning: "大会", sort: 3 },
  { id: `opt-${itemKey}-morning`, code: "morning", label: "前", meaning: "午前のみ", sort: 4 },
  { id: `opt-${itemKey}-afternoon`, code: "afternoon", label: "後", meaning: "午後のみ", sort: 5 },
  { id: `opt-${itemKey}-meeting`, code: "meeting", label: "ミ", meaning: "ミーティング", sort: 6 },
];

export const PRESETS: Record<PresetKey, Preset> = {
  elementary_no_bus: {
    key: "elementary_no_bus",
    targetGroups: [],
    itemDefinitions: [eventsItem, lunchItem, dismissalItem],
  },

  elementary_bus: {
    key: "elementary_bus",
    targetGroups: [
      {
        group: { id: "tg-bus-route", key: "bus_route", name: "スクールバス便", sort: 1 },
        targets: [
          { id: "tgt-bus-1", targetGroupId: "tg-bus-route", code: "1", name: "①便", sort: 1 },
          { id: "tgt-bus-2", targetGroupId: "tg-bus-route", code: "2", name: "②便", sort: 2 },
          { id: "tgt-bus-3", targetGroupId: "tg-bus-route", code: "3", name: "③便", sort: 3 },
          { id: "tgt-bus-4", targetGroupId: "tg-bus-route", code: "4", name: "④便", sort: 4 },
        ],
      },
    ],
    itemDefinitions: [
      eventsItem,
      lunchItem,
      dismissalItem,
      {
        id: "item-bus",
        key: "bus",
        name: "スクールバス",
        valueType: "time",
        targetGroupId: "tg-bus-route",
        granularity: "day",
        defaultVisibility: "guardian",
        sort: 4,
      },
      {
        id: "item-cleaning",
        key: "cleaning",
        name: "清掃",
        valueType: "symbol",
        granularity: "day",
        defaultVisibility: "staff_only",
        sort: 5,
        options: yesNoOptions("cleaning", "清掃がある", "清掃がない"),
      },
      {
        id: "item-after-school",
        key: "after_school",
        name: "放課後",
        valueType: "symbol",
        granularity: "day",
        defaultVisibility: "staff_only",
        sort: 6,
        options: yesNoOptions("after-school", "放課後の活動がある", "放課後の活動がない"),
      },
      {
        id: "item-staff-movement",
        key: "staff_movement",
        name: "職員動静",
        valueType: "event_list",
        granularity: "day",
        defaultVisibility: "staff_only",
        sort: 7,
      },
      {
        id: "item-deadline",
        key: "deadline",
        name: "〆切",
        valueType: "event_list",
        granularity: "day",
        defaultVisibility: "staff_only",
        sort: 8,
      },
    ],
  },

  junior_high: {
    key: "junior_high",
    targetGroups: [
      {
        // The axis and the per-club item ship with the preset; the
        // school adds its own clubs as targets (DESIGN schedule 5.2
        // scenario 5: the per-club form needs no schema change).
        group: { id: "tg-club", key: "club", name: "部活動", sort: 1 },
        targets: [],
      },
    ],
    itemDefinitions: [
      eventsItem,
      lunchItem,
      {
        id: "item-club-day",
        key: "club_day",
        name: "部活動",
        valueType: "symbol",
        granularity: "day",
        defaultVisibility: "guardian",
        sort: 3,
        options: clubOptions("club-day"),
      },
      {
        id: "item-club-activity",
        key: "club_activity",
        name: "部活動（部別）",
        valueType: "symbol",
        targetGroupId: "tg-club",
        granularity: "day",
        defaultVisibility: "staff_only",
        sort: 4,
        options: clubOptions("club-activity"),
      },
      {
        id: "item-student-council",
        key: "student_council",
        name: "生徒会",
        valueType: "event_list",
        granularity: "day",
        defaultVisibility: "staff_only",
        sort: 5,
      },
      {
        id: "item-final-dismissal",
        key: "final_dismissal",
        name: "最終下校",
        valueType: "time",
        granularity: "day",
        defaultVisibility: "guardian",
        sort: 6,
      },
    ],
  },
};
