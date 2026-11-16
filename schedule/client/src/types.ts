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
  isActive?: boolean;
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

/**
 * One duty definition with its rotation rule, as getBootstrap
 * returns it (Issue #38): the name labels the table's duty columns,
 * and the rotation's roster is what the panel's preview offers.
 */
export interface DutyDefinitionData {
  id: string;
  name: string;
  granularity: string;
  applicablePeriod: string;
  applicableStartsOn: string | null;
  applicableEndsOn: string | null;
  targetGroupId: string | null;
  sort: number;
  rotation: { personIds: string[]; changeWeekdays: string[] | null } | null;
}

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
  dutyDefinitions: DutyDefinitionData[];
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
  targetId: string | null;
  /** How the row came to be: "auto" (rotation), "manual", or
   *  "swap" (a change was applied — the table's swapped mark). */
  origin: string;
  note: string | null;
}

/**
 * One derived duty conflict, in the shared shape of
 * @school-manage/calendar-types' DutyConflict (Issue #31 / #69):
 * an assignment overlapping an absence (certainty "tentative"
 * marks a not-yet-confirmed absence), one person holding two
 * duties in one slot, or an applicable cell standing unassigned.
 */
export interface DutyConflictData {
  kind: "absence" | "double" | "unassigned";
  assignmentId: string | null;
  otherAssignmentId: string | null;
  dutyDefinitionId: string;
  dutyName: string;
  date: string;
  slot: string;
  personId: string | null;
  absenceId: string | null;
  absenceKind: string | null;
  certainty: string | null;
}

/** One recorded duty change (Issue #31), as getDutyChanges returns
 *  the row: a proposal until an Editor or Admin applies or
 *  declines it. */
export interface DutyChangeData {
  id: string;
  dutyDefinitionId: string;
  kind: "swap" | "substitute" | "reassign";
  assignmentAId: string;
  assignmentBId: string | null;
  fromPersonId: string | null;
  toPersonId: string | null;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  status: "proposed" | "applied" | "declined";
  createdAt: string;
  appliedAt: string | null;
}

/** One cell of a rotation preview (Issue #30): who the rotation
 *  would put there, and what applying would do to the cell. */
export interface RotationPlanCellData {
  date: string;
  slot: string;
  personId: string;
  action: "create" | "replace" | "keep";
  existing: DutyAssignmentData | null;
}

export interface ApplyRotationResultData {
  created: number;
  updated: number;
  skipped: number;
  assignments: DutyAssignmentData[];
}

/** One location of the school's own master (Issue #27), as the
 *  definition set returns it. */
export interface LocationData {
  id: string;
  name: string;
  kind: string | null;
  sort: number;
  isActive: boolean;
}

/** The school's settings row (Issue #27): how cell input opens
 *  (Issue #36's popover or the modal) and which absence kinds
 *  count for duty conflicts (Issue #31; null counts every kind). */
export interface SchoolSettingsData {
  inputOpener: "popover" | "modal";
  dutyConflictAbsenceKinds: string[] | null;
}

/** The whole definition set, as getDefinitions returns it
 *  (Issue #39): what the settings screen edits. */
export interface DefinitionSetData {
  settings: SchoolSettingsData | null;
  targetGroups: TargetGroupData[];
  itemDefinitions: ItemDefinitionData[];
  locations: LocationData[];
}

/** The shared masters, as the master relay returns them
 *  (Issue #39): the platform's records, one list per kind. The
 *  records stay MasterEntry-shaped — the platform owns their
 *  fields and validates every write. */
export interface MastersData {
  staff: MasterEntry[];
  grade: MasterEntry[];
  class: MasterEntry[];
  special_needs_class: MasterEntry[];
  day_pattern: MasterEntry[];
}

/** The master kinds the settings screen edits, in list order. */
export type MasterKindData = keyof MastersData;

/** One row of the confirmation queue (Issue #39): a tentative
 *  platform record — an absence from the platform's pending
 *  list, or an event the relay kept from its range read. The
 *  record stays opaque; the panel reads the fields it draws. */
export type PendingRecord = Record<string, unknown>;

export interface RangeData {
  view: ViewDefinitionData;
  from: string;
  to: string;
  days: RangeDayData[];
  undecided: { month: string | null; events: Record<string, unknown>[] }[];
  eventValues: unknown[];
  conflicts: DutyConflictData[];
}
