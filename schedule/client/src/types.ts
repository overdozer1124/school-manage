/**
 * The shapes the schedule screens read (Issue #34). These mirror the
 * results of the server actions of Issue #33 (getBootstrap /
 * getRange in schedule/src/range) as they cross the HTTP boundary as
 * JSON: database rows keep their camelCase field names, and the
 * platform's records (days, holidays, events, absences) stay opaque
 * records, exactly as the server passes them through. The client
 * reads only the fields it draws and never widens them.
 */

export interface ViewColumnData {
  id: string;
  viewDefinitionId: string;
  sourceKind: "event_category" | "daily_item" | "duty" | "day_attribute";
  itemDefinitionId: string | null;
  dutyDefinitionId: string | null;
  targetGroupId: string | null;
  groupSameValues: boolean;
  widthHint: number | null;
  sort: number;
}

export interface ViewDefinitionData {
  id: string;
  name: string;
  layout: string;
  layoutParams: Record<string, unknown> | null;
  audience: string;
  periodScope: string;
  printSettings: Record<string, unknown> | null;
  columns: ViewColumnData[];
}

export interface ItemOptionData {
  id: string;
  itemDefinitionId?: string;
  code: string;
  label: string;
  meaning?: string | null;
  sort: number;
}

export interface ItemDefinitionData {
  id: string;
  key: string;
  name: string;
  valueType: string;
  targetGroupId: string | null;
  targetPlatformAxis: string | null;
  granularity: string;
  defaultVisibility: string;
  sort: number;
  options: ItemOptionData[];
}

export interface TargetData {
  id: string;
  targetGroupId: string;
  code?: string | null;
  name: string;
  shortName?: string | null;
  sort: number;
}

export interface TargetGroupData {
  id: string;
  key: string;
  name: string;
  sort: number;
  targets: TargetData[];
}

export interface MasterEntry {
  id: string;
  name?: string;
  code?: string;
  [key: string]: unknown;
}

/** A kind template (Issue #29), as getBootstrap returns it: the
 *  shape of one kind of entry — which platform record it saves as,
 *  whose name the cell's text is for person-led kinds, and how the
 *  cell line is led (DESIGN schedule 6.3.1). */
export interface KindTemplateData {
  id: string;
  key: string;
  name: string;
  subjectKind: "event" | "absence";
  kindCode: string;
  personLabel: string;
  displaySource: "title" | "person" | "person_title";
  steps: { kind: string; itemDefinitionId?: string | null }[];
  itemDefinitionIds?: string[];
  sort: number;
}

/** A daily value's target, as the write actions take it
 *  (schedule/src/dailyValues/types.ts): a platform axis member, or a
 *  member of one of this app's own target groups. */
export type TargetRefData =
  | { axis: "grade" | "class" | "special_needs_class" | "staff" | "room"; id: string }
  | { axis: "app"; app: "schedule"; axisKey: string; id: string };

export interface BootstrapData {
  school: { id: string; name: string | null };
  userId: string;
  teacherId: string | null;
  role: string;
  permissions: string[];
  views: ViewDefinitionData[];
  itemDefinitions: ItemDefinitionData[];
  targetGroups: TargetGroupData[];
  kindTemplates: KindTemplateData[];
  masters: {
    staff: MasterEntry[];
    grades: MasterEntry[];
    dayPatterns: MasterEntry[];
  };
}

/** One day of a range, as getRange bundles it (Issue #33). */
export interface RangeDayData {
  date: string;
  day: Record<string, unknown>;
  holidays: Record<string, unknown>[];
  events: Record<string, unknown>[];
  absences: Record<string, unknown>[];
  dailyValues: DailyValueData[];
  dutyAssignments: DutyAssignmentData[];
}

export interface DailyValueData {
  id: string;
  date: string;
  itemDefinitionId: string;
  targetId: string | null;
  targetRef: { axis: string; id: string; axisKey?: string } | null;
  slot: string;
  valueText: string | null;
  valueTime: string | null;
  valueTimeEnd: string | null;
  valueNumber: number | null;
  valueBoolean: boolean | null;
  valueOptionId: string | null;
  valuePersonId: string | null;
}

export interface DutyAssignmentData {
  id: string;
  dutyDefinitionId: string;
  date: string;
  slot: string;
  personId: string | null;
  note: string | null;
}

export interface RangeData {
  view: ViewDefinitionData;
  from: string;
  to: string;
  days: RangeDayData[];
  undecided: { month: string | null; events: Record<string, unknown>[] }[];
  eventValues: unknown[];
  conflicts: unknown[];
}
