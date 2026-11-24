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
  /** Off the everyday list and the view switcher (Issue #87);
   *  the view, its publications and its public URLs stay. */
  isArchived: boolean;
  columns: ViewColumnData[];
}

export interface ItemOptionData {
  id: string;
  itemDefinitionId?: string;
  code: string;
  label: string;
  meaning?: string | null;
  sort: number;
  /** The option's aggregation condition (DESIGN schedule 4.4),
   *  as the server sends it; absent on older payloads. */
  countsAs?: Record<string, unknown> | boolean | null;
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
  /** Whether the item's days are counted by the summary
   *  (Issue #47); absent on older payloads. */
  isAggregatable?: boolean;
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
  /** The stop switch (Issue #86): a stopped duty keeps its
   *  assignments and history but takes no new ones. */
  isActive: boolean;
  rotation: { personIds: string[]; changeWeekdays: string[] | null } | null;
}

/** A registered place (DESIGN schedule 4.5.1), as getBootstrap
 *  returns it from this app's own locations master: the quick-entry
 *  popover's location step offers these, and a place typed freely
 *  is kept as the event's location text instead (Issue #36). */
export interface LocationData {
  id: string;
  name: string;
  kind: string | null;
  sort: number;
  isActive: boolean;
}

/** One of the school's absence subdivision definitions, as the
 *  platform keeps them (Issue #25): under a fixed absence kind
 *  (code), the school's own key and word （年休 under leave). The
 *  quick-entry popover's subdivision step offers the ones under
 *  the entry's kind, by label (Issue #36). */
export interface AbsenceSubdivisionData {
  id: string;
  code: string;
  key: string;
  label: string;
  /** The school's display order within the kind (Issue #91):
   *  the settings screen's 上へ・下へ rewrites these, and the
   *  modal offers the subdivisions in this order. */
  sort: number;
  /** The platform record's revision: an update or a delete from
   *  the settings screen carries the revision last read (Issue
   *  #84), as the shared masters' edits do. */
  revision: number;
}

/** One additional item value of a platform record (Issue #29), in
 *  the row shape getEventValues returns: the typed value columns
 *  mirror the daily values'. */
export interface EventValueData {
  id: string;
  itemDefinitionId: string;
  targetId: string | null;
  targetRef: TargetRefData | null;
  valueText: string | null;
  valueTime: string | null;
  valueTimeEnd: string | null;
  valueNumber: number | null;
  valueBoolean: boolean | null;
  valueOptionId: string | null;
  valuePersonId: string | null;
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
  /** The quick-entry popover's raw materials (Issue #36). */
  locations: LocationData[];
  absenceSubdivisions: AbsenceSubdivisionData[];
  /** The school's default input behaviour (DESIGN schedule 6.5):
   *  after Enter, open the quick-entry popover, or — for schools
   *  that prefer it — the detail modal (Issue #37). */
  inputOpener: "popover" | "modal";
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

/** The print settings one publication was generated with
 *  (Issue #40, DESIGN schedule 9.1): paper, orientation, margin
 *  and the font-size step. The view definition carries the
 *  school's defaults; a publication records the effective set. */
export interface PrintSettingsData {
  paper: "A4" | "A3";
  orientation: "landscape" | "portrait";
  marginMm: number;
  fontScale: "small" | "medium" | "large";
}

/** One issued version of a view's month table (Issue #40), as
 *  the version list returns it: the record, without the document.
 *  The document of an issued publication is never rewritten —
 *  to hand out a corrected table, a new version is issued. The
 *  record around it may move (Issue #48): the label and note
 *  can be corrected, and cancelledAt stamps a version that was
 *  withdrawn — the row stays in the list, marked cancelled.
 *  Issue #49 issues the other layouts as well, and a version
 *  names the period it covers: rangeFrom / rangeTo are the
 *  span's first and last days — null on versions issued before
 *  spans were recorded, whose period is their target month. */
export interface PublicationData {
  id: string;
  viewDefinitionId: string;
  targetMonth: string;
  versionLabel: string;
  publishedAt: string;
  publishedBy: string;
  snapshotNote: string | null;
  printSettings: PrintSettingsData;
  documentFormat: string;
  cancelledAt: string | null;
  rangeFrom: string | null;
  rangeTo: string | null;
}

/** One issued publication with its document: the stored,
 *  self-contained print HTML, returned byte for byte as issued. */
export interface PublicationDocumentData extends PublicationData {
  documentHtml: string;
}

/** One column's text change on one day, in a version diff
 *  (Issue #48). An empty side is a column or value that exists
 *  on only one of the two versions. */
export interface PublicationCellChangeData {
  columnId: string;
  label: string;
  before: string;
  after: string;
}

/** One changed day of a version diff: the day-type change when
 *  the type moved, and the day's changed cells. Unchanged days
 *  are not listed at all. */
export interface PublicationDayChangeData {
  date: string;
  dayType?: { before: string; after: string };
  cells: PublicationCellChangeData[];
}

/** getPublicationDiff's answer (Issue #48): how one version
 *  differs from the version issued before it. comparable is
 *  false when either side predates the structured snapshot —
 *  the documents exist, but there is nothing structured to
 *  compare — and then changes is absent. A comparable diff
 *  with fromId null is the first version of its view and
 *  month: there is no previous version. */
export interface PublicationDiffData {
  comparable: boolean;
  fromId: string | null;
  toId: string;
  changes?: PublicationDayChangeData[];
}

/** One month of a view's accompanying notes (Issue #46), as
 *  getRange returns them on the range: the student table's
 *  生活目標・健康目標 for that month. Either goal may be unset
 *  (null) while the other stands written. */
export interface ViewMonthNoteData {
  month: string;
  lifeGoal: string | null;
  healthGoal: string | null;
}

export interface RangeData {
  view: ViewDefinitionData;
  from: string;
  to: string;
  days: RangeDayData[];
  undecided: { month: string | null; events: Record<string, unknown>[] }[];
  eventValues: unknown[];
  conflicts: DutyConflictData[];
  /** The view's month notes for the months this range covers
   *  (Issue #46): a month nobody wrote notes for is absent. */
  monthNotes: ViewMonthNoteData[];
}

// ---- summary (Issue #47) ------------------------------------------

/** One day type's day count in a summary period, in the fixed
 *  code order the server derives. */
export interface SummaryDayTypeCountData {
  dayType: string;
  count: number;
}

/** One target's distinct counted days for an item; a null
 *  targetId is the item's unsplit （全体） values. */
export interface SummaryTargetCountData {
  targetId: string | null;
  targetName: string;
  count: number;
}

/** One aggregatable item's counts in a period: the distinct
 *  days any target counted, and the per-target breakdown. */
export interface SummaryItemCountData {
  itemId: string;
  name: string;
  total: number;
  byTarget: SummaryTargetCountData[];
}

/** One period's counts (a month bucket, or the whole range). */
export interface SummaryPeriodData {
  schoolDays: number;
  dayTypeCounts: SummaryDayTypeCountData[];
  items: SummaryItemCountData[];
}

/** One month bucket of a summary. */
export interface SummaryMonthData extends SummaryPeriodData {
  month: string;
}

/** getSummary's answer: the derived counts of one view over
 *  one period — school days and the aggregatable items' days,
 *  per month and in total. Nothing behind it is stored. */
export interface SummaryData {
  from: string;
  to: string;
  viewId: string;
  months: SummaryMonthData[];
  total: SummaryPeriodData;
}

// ---- public viewing (Issue #41) -----------------------------------

/** One issued public-view token, as the settings screen lists
 *  it. The token's value is never here — it was returned once,
 *  by the issuing call below, and is nowhere else. */
export interface PublicViewTokenData {
  id: string;
  viewDefinitionId: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

/** The issuing call's answer: the row, plus the token's value,
 *  shown once so the URL can be copied. */
export interface PublicTokenCreatedData extends PublicViewTokenData {
  token: string;
}

/** The public range (Issue #41) with the latest-version
 *  notice (Issue #48): the newest non-cancelled version issued
 *  for the view's month at the range's head, named by its label
 *  and its issue date — the two facts the printed document
 *  itself carries — or null when the month has no live version
 *  to announce. */
export interface PublicRangeData extends RangeData {
  latestPublication: { versionLabel: string; publishedAt: string } | null;
}

/** What the public screen opens with: the school's name, the
 *  token's one view (already audience-filtered server-side), the
 *  items its columns show, the target axes those items range
 *  over, and the year's holidays. No staff master, no people. */
export interface PublicBootstrapData {
  school: { id: string; name: string };
  view: ViewDefinitionData;
  itemDefinitions: ItemDefinitionData[];
  targetGroups: TargetGroupData[];
  grades: MasterEntry[];
  holidays: Record<string, unknown>[];
}
