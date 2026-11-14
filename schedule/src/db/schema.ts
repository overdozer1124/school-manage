import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { TargetRef } from "@school-manage/calendar-types";

/**
 * Schedule's own schema. The school master itself lives in the
 * platform (the source of truth); this database holds only a display
 * cache of the school name and slug (DESIGN-AUTH-TENANCY 3.1).
 * Business tables arrive with their own issues; every one of them
 * carries school_id, with per-school uniqueness and composite foreign
 * keys, as in the platform schema.
 */
export const schoolCache = pgTable("school_cache", {
  schoolId: text("school_id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
});

export type SchoolCacheRow = typeof schoolCache.$inferSelect;

/**
 * Per-school settings (DESIGN-AUTH-TENANCY 3.2, schedule side): one
 * row per school. Records which preset was applied and the default
 * input behaviour (quick-entry popover or detail modal, DESIGN
 * schedule 6.5).
 */
export const schoolSettings = pgTable(
  "school_settings",
  {
    schoolId: text("school_id").primaryKey(),
    presetKey: text("preset_key"),
    presetAppliedAt: timestamp("preset_applied_at", { withTimezone: true }),
    inputOpener: text("input_opener").default("popover").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("school_settings_input_opener_check", sql`${t.inputOpener} in ('popover', 'modal')`),
  ],
);

export type SchoolSettingsRow = typeof schoolSettings.$inferSelect;

/**
 * An app-specific target axis (DESIGN schedule 4.3): clubs, bus
 * routes, committees. Grades and classes are NOT kept here; they are
 * shared masters in the platform, referenced through the platform
 * axis on item definitions (DESIGN-INTEGRATION 2.4).
 */
export const targetGroups = pgTable(
  "target_groups",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    sort: integer("sort").default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.id] }), unique().on(t.schoolId, t.key)],
);

export type TargetGroupRow = typeof targetGroups.$inferSelect;

/** One entry on an app-specific axis (DESIGN schedule 4.3). */
export const targets = pgTable(
  "targets",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    targetGroupId: text("target_group_id").notNull(),
    code: text("code"),
    name: text("name").notNull(),
    sort: integer("sort").default(0).notNull(),
    parentTargetId: text("parent_target_id"),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    foreignKey({
      name: "targets_group_fk",
      columns: [t.schoolId, t.targetGroupId],
      foreignColumns: [targetGroups.schoolId, targetGroups.id],
    }),
    foreignKey({
      name: "targets_parent_fk",
      columns: [t.schoolId, t.parentTargetId],
      foreignColumns: [t.schoolId, t.id],
    }),
  ],
);

export type TargetRow = typeof targets.$inferSelect;

/**
 * An item definition: one "column" of the schedule (DESIGN schedule
 * 4.4). The axis it varies over is either a platform axis
 * (target_platform_axis: grade / class / special_needs_class, whose
 * entries are the shared masters) or an app-specific target group
 * (target_group_id); the check keeps at most one of the two set, and
 * null on both means the item is uniform across the school.
 */
export const itemDefinitions = pgTable(
  "item_definitions",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    valueType: text("value_type").notNull(),
    targetGroupId: text("target_group_id"),
    targetPlatformAxis: text("target_platform_axis"),
    granularity: text("granularity").notNull(),
    defaultVisibility: text("default_visibility").notNull(),
    isAggregatable: boolean("is_aggregatable").default(false).notNull(),
    sort: integer("sort").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique().on(t.schoolId, t.key),
    foreignKey({
      name: "item_definitions_group_fk",
      columns: [t.schoolId, t.targetGroupId],
      foreignColumns: [targetGroups.schoolId, targetGroups.id],
    }),
    check(
      "item_definitions_value_type_check",
      sql`${t.valueType} in ('text', 'event_list', 'time', 'time_range', 'symbol', 'code', 'person', 'persons', 'number', 'boolean', 'target_time_map')`,
    ),
    check(
      "item_definitions_platform_axis_check",
      sql`${t.targetPlatformAxis} is null or ${t.targetPlatformAxis} in ('grade', 'class', 'special_needs_class')`,
    ),
    check(
      "item_definitions_axis_check",
      sql`${t.targetGroupId} is null or ${t.targetPlatformAxis} is null`,
    ),
    check(
      "item_definitions_granularity_check",
      sql`${t.granularity} in ('day', 'am_pm', 'period', 'week', 'month')`,
    ),
    check(
      "item_definitions_visibility_check",
      sql`${t.defaultVisibility} in ('staff_only', 'guardian', 'student', 'public')`,
    ),
  ],
);

export type ItemDefinitionRow = typeof itemDefinitions.$inferSelect;

/** One legend entry of a symbol/code item (DESIGN schedule 4.4). */
export const itemOptions = pgTable(
  "item_options",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    itemDefinitionId: text("item_definition_id").notNull(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    meaning: text("meaning"),
    colorHint: text("color_hint"),
    countsAs: jsonb("counts_as").$type<Record<string, unknown>>(),
    sort: integer("sort").default(0).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique().on(t.schoolId, t.itemDefinitionId, t.code),
    foreignKey({
      name: "item_options_definition_fk",
      columns: [t.schoolId, t.itemDefinitionId],
      foreignColumns: [itemDefinitions.schoolId, itemDefinitions.id],
    }).onDelete("cascade"),
  ],
);

export type ItemOptionRow = typeof itemOptions.$inferSelect;

/** A registered place (DESIGN schedule 4.5.1). */
export const locations = pgTable(
  "locations",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    kind: text("kind"),
    sort: integer("sort").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.id] })],
);

export type LocationRow = typeof locations.$inferSelect;

/**
 * A daily value: the content of one cell of the schedule table,
 * "date x item x target" (DESIGN schedule 4.6, 3). Events are not
 * stored here; this is for the day's state that is not an event
 * (lunch yes/no, dismissal times, bus times).
 *
 * The target is optional. A target on an app-specific axis is a row
 * of `targets`, referenced by target_id (composite FK). A target on
 * a shared-master axis (grade, class, ...) cannot be a foreign key
 * into the platform, so it is kept as a TargetRef in target_ref
 * (DESIGN-INTEGRATION 8-1-3). At most one of the two is set; both
 * null means the value is not split by target. target_key is the
 * canonical text form of the target ("" for none, "app:<id>" for an
 * app target, "<axis>:<id>" for a shared-master one) and exists so
 * the cell uniqueness below can be a plain unique constraint even
 * though the target columns are nullable.
 *
 * The value is stored in typed columns, in the EventValue form
 * (DESIGN schedule 4.5): exactly one group is used, chosen by the
 * item definition's value_type and checked when the value is set.
 * value_option_id deliberately has no foreign key: definition
 * writes replace an item's options wholesale (Issue #27), and a key
 * would make that fail once values exist; the option's existence is
 * enforced at write time instead.
 */
export const dailyValues = pgTable(
  "daily_values",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    date: date("date").notNull(),
    itemDefinitionId: text("item_definition_id").notNull(),
    targetId: text("target_id"),
    targetRef: jsonb("target_ref").$type<TargetRef>(),
    targetKey: text("target_key").default("").notNull(),
    slot: text("slot").default("all_day").notNull(),
    valueText: text("value_text"),
    valueTime: text("value_time"),
    valueTimeEnd: text("value_time_end"),
    valueNumber: doublePrecision("value_number"),
    valueBoolean: boolean("value_boolean"),
    valueOptionId: text("value_option_id"),
    valuePersonId: text("value_person_id"),
    valueJson: jsonb("value_json"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("daily_values_cell_unique").on(
      t.schoolId,
      t.date,
      t.itemDefinitionId,
      t.targetKey,
      t.slot,
    ),
    foreignKey({
      name: "daily_values_item_fk",
      columns: [t.schoolId, t.itemDefinitionId],
      foreignColumns: [itemDefinitions.schoolId, itemDefinitions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "daily_values_target_fk",
      columns: [t.schoolId, t.targetId],
      foreignColumns: [targets.schoolId, targets.id],
    }),
    check("daily_values_target_check", sql`${t.targetId} is null or ${t.targetRef} is null`),
    check(
      "daily_values_slot_check",
      sql`${t.slot} in ('all_day', 'am', 'pm') or ${t.slot} ~ '^[0-9]+$'`,
    ),
  ],
);

export type DailyValueRow = typeof dailyValues.$inferSelect;

/**
 * A duty definition: one kind of duty a school runs (DESIGN schedule
 * 4.7) — 日番, 日直, 週番, 清掃当番 — under the school's own name.
 * granularity says how the duty repeats (a whole day, morning /
 * afternoon halves, a week, or lesson periods); applicable_period
 * says when it is in force. For long_vacation_only and term the
 * platform calendar decides (its day types and its terms), so no
 * dates are configured here; the range columns belong to
 * custom_range. target_group_id names the axis when the duty is the
 * students' rather than the staff's; null is a staff duty.
 */
export const dutyDefinitions = pgTable(
  "duty_definitions",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    granularity: text("granularity").notNull(),
    applicablePeriod: text("applicable_period").notNull(),
    applicableStartsOn: date("applicable_starts_on"),
    applicableEndsOn: date("applicable_ends_on"),
    targetGroupId: text("target_group_id"),
    sort: integer("sort").default(0).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    foreignKey({
      name: "duty_definitions_group_fk",
      columns: [t.schoolId, t.targetGroupId],
      foreignColumns: [targetGroups.schoolId, targetGroups.id],
    }),
    check(
      "duty_definitions_granularity_check",
      sql`${t.granularity} in ('day', 'am_pm', 'week', 'period')`,
    ),
    check(
      "duty_definitions_applicable_period_check",
      sql`${t.applicablePeriod} in ('all_year', 'term', 'long_vacation_only', 'custom_range')`,
    ),
    check(
      "duty_definitions_range_order",
      sql`${t.applicableStartsOn} is null or ${t.applicableEndsOn} is null or ${t.applicableStartsOn} <= ${t.applicableEndsOn}`,
    ),
  ],
);

export type DutyDefinitionRow = typeof dutyDefinitions.$inferSelect;

/**
 * The rotation rule of one duty definition (DESIGN schedule 4.7):
 * the roster, in order, and the weekdays the holder changes on.
 * The roster names the platform's staff masters (DESIGN-INTEGRATION
 * 2.4) — staff ids cannot be a foreign key from this database, so
 * membership in the school's staff is checked against the platform
 * when a rule is written (Issue #30). One rule per definition.
 * change_weekdays is null when the holder advances at every cell;
 * for a week duty its first entry is also the day the week starts
 * (週番の金曜交代 means the week runs Friday to Thursday).
 */
export const rotationRules = pgTable(
  "rotation_rules",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    dutyDefinitionId: text("duty_definition_id").notNull(),
    personIds: jsonb("person_ids").$type<string[]>().notNull(),
    changeWeekdays: jsonb("change_weekdays").$type<string[]>(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("rotation_rules_definition_unique").on(t.schoolId, t.dutyDefinitionId),
    foreignKey({
      name: "rotation_rules_definition_fk",
      columns: [t.schoolId, t.dutyDefinitionId],
      foreignColumns: [dutyDefinitions.schoolId, dutyDefinitions.id],
    }).onDelete("cascade"),
  ],
);

export type RotationRuleRow = typeof rotationRules.$inferSelect;

/**
 * One duty assignment (DESIGN schedule 4.7): who holds a duty on a
 * date (the week's first day for a week duty), in a slot. The holder
 * is a staff member (person_id, a platform staff-master id — no
 * foreign key is possible, so it is checked against the platform
 * when written) or, for a students' duty, a row of `targets`
 * (target_id, composite FK); never both. origin records how the
 * assignment came to be (auto generation, a manual set, a swap) and
 * is_manual_override marks a manual set that replaced a generated
 * one; automatic generation never overwrites a manual or swap row.
 * Audit columns follow DESIGN-AUTH-TENANCY 4.7.
 */
export const dutyAssignments = pgTable(
  "duty_assignments",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    dutyDefinitionId: text("duty_definition_id").notNull(),
    date: date("date").notNull(),
    slot: text("slot").default("all_day").notNull(),
    personId: text("person_id"),
    targetId: text("target_id"),
    note: text("note"),
    origin: text("origin").default("manual").notNull(),
    isManualOverride: boolean("is_manual_override").default(false).notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("duty_assignments_cell_unique").on(t.schoolId, t.dutyDefinitionId, t.date, t.slot),
    foreignKey({
      name: "duty_assignments_definition_fk",
      columns: [t.schoolId, t.dutyDefinitionId],
      foreignColumns: [dutyDefinitions.schoolId, dutyDefinitions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "duty_assignments_target_fk",
      columns: [t.schoolId, t.targetId],
      foreignColumns: [targets.schoolId, targets.id],
    }),
    check("duty_assignments_holder_check", sql`${t.personId} is null or ${t.targetId} is null`),
    check("duty_assignments_origin_check", sql`${t.origin} in ('auto', 'manual', 'swap')`),
    check(
      "duty_assignments_slot_check",
      sql`${t.slot} in ('all_day', 'am', 'pm', 'week') or ${t.slot} ~ '^[0-9]+$'`,
    ),
  ],
);

export type DutyAssignmentRow = typeof dutyAssignments.$inferSelect;

/**
 * A view definition: how a slice of the schedule is shown, without
 * holding any data itself (DESIGN schedule 4.8). layout is one of
 * the 4.8.1 catalog keys, including the Phase 2 layouts — a
 * definition may name a layout a screen cannot render yet, and the
 * screen deals with that. layout_params and print_settings are
 * layout / print specific JSON kept as-is here (print_settings is
 * consumed by the printing issue). audience is the view's public
 * reach; the effective rank of a read through it is
 * max(0, audience rank) (DESIGN-AUTH-TENANCY 4.5, implemented as a
 * pure function in @school-manage/calendar-types).
 */
export const viewDefinitions = pgTable(
  "view_definitions",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    layout: text("layout").notNull(),
    layoutParams: jsonb("layout_params_json").$type<Record<string, unknown>>(),
    audience: text("audience").notNull(),
    periodScope: text("period_scope").notNull(),
    printSettings: jsonb("print_settings").$type<Record<string, unknown>>(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("view_definitions_school_name_unique").on(t.schoolId, t.name),
    check(
      "view_definitions_layout_check",
      sql`${t.layout} in ('month_rows', 'week_rows', 'year_columns', 'calendar_grid', 'week_timeline', 'transposed')`,
    ),
    check(
      "view_definitions_audience_check",
      sql`${t.audience} in ('staff', 'guardian', 'student', 'public')`,
    ),
    check(
      "view_definitions_period_scope_check",
      sql`${t.periodScope} in ('week', 'two_weeks', 'month', 'year')`,
    ),
  ],
);

export type ViewDefinitionRow = typeof viewDefinitions.$inferSelect;

/**
 * One column of a view (DESIGN schedule 4.8). What it draws is
 * source_kind: an event category, a daily item, a duty, or an
 * attribute of the day itself. A daily_item column references its
 * item definition (composite FK; deleting an item a view still
 * uses is refused, so a view cannot silently lose a column). A duty
 * column keys into its duty definition the same way since Issue
 * #30 gave duty definitions a table in this database; deleting a
 * duty definition a view still uses is refused too. (The decision
 * PR #62 left open; the platform-side value_option_id stays keyless
 * because its table is in another database, Issue #28.)
 * target_group_id expands the column per target of that axis;
 * null shows the column once. group_same_values switches the
 * 4.8.2 same-value grouping for this column (default on).
 */
export const viewColumns = pgTable(
  "view_columns",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    viewDefinitionId: text("view_definition_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    itemDefinitionId: text("item_definition_id"),
    dutyDefinitionId: text("duty_definition_id"),
    targetGroupId: text("target_group_id"),
    groupSameValues: boolean("group_same_values").default(true).notNull(),
    widthHint: integer("width_hint"),
    sort: integer("sort").default(0).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    foreignKey({
      name: "view_columns_view_fk",
      columns: [t.schoolId, t.viewDefinitionId],
      foreignColumns: [viewDefinitions.schoolId, viewDefinitions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "view_columns_item_fk",
      columns: [t.schoolId, t.itemDefinitionId],
      foreignColumns: [itemDefinitions.schoolId, itemDefinitions.id],
    }),
    foreignKey({
      name: "view_columns_duty_fk",
      columns: [t.schoolId, t.dutyDefinitionId],
      foreignColumns: [dutyDefinitions.schoolId, dutyDefinitions.id],
    }),
    foreignKey({
      name: "view_columns_target_group_fk",
      columns: [t.schoolId, t.targetGroupId],
      foreignColumns: [targetGroups.schoolId, targetGroups.id],
    }),
    check(
      "view_columns_source_kind_check",
      sql`${t.sourceKind} in ('event_category', 'daily_item', 'duty', 'day_attribute')`,
    ),
    check(
      "view_columns_source_ref_check",
      sql`(${t.sourceKind} = 'daily_item' and ${t.itemDefinitionId} is not null and ${t.dutyDefinitionId} is null)
        or (${t.sourceKind} = 'duty' and ${t.dutyDefinitionId} is not null and ${t.itemDefinitionId} is null)
        or (${t.sourceKind} in ('event_category', 'day_attribute') and ${t.itemDefinitionId} is null and ${t.dutyDefinitionId} is null)`,
    ),
  ],
);

export type ViewColumnRow = typeof viewColumns.$inferSelect;

/**
 * An additional item value attached to a platform record (DESIGN
 * schedule 4.5 `event_values`, DESIGN-INTEGRATION 10 implementation
 * 2): the school-defined extras of an event or an absence (a
 * deadline's destination, the details of a business trip) live in
 * this database, keyed by the platform record's id, because the
 * platform holds only the shared skeleton. subject_kind says which
 * platform record subject_id names; there is deliberately no
 * foreign key on it — the record lives in another database, and its
 * existence is established by the platform call that precedes the
 * values write (Issue #29).
 *
 * The target and typed-value columns follow daily_values exactly
 * (same TargetRef / target_key treatment, same value columns), so a
 * value reads the same whichever table holds it. The target is
 * optional here (DESIGN 4.5: target_id nullable): a value that is
 * not split by target carries the empty target key alongside any
 * per-target values of the same item.
 */
export const eventValues = pgTable(
  "event_values",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: text("subject_id").notNull(),
    itemDefinitionId: text("item_definition_id").notNull(),
    targetId: text("target_id"),
    targetRef: jsonb("target_ref").$type<TargetRef>(),
    targetKey: text("target_key").default("").notNull(),
    valueText: text("value_text"),
    valueTime: text("value_time"),
    valueTimeEnd: text("value_time_end"),
    valueNumber: doublePrecision("value_number"),
    valueBoolean: boolean("value_boolean"),
    valueOptionId: text("value_option_id"),
    valuePersonId: text("value_person_id"),
    valueJson: jsonb("value_json"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("event_values_subject_item_unique").on(
      t.schoolId,
      t.subjectKind,
      t.subjectId,
      t.itemDefinitionId,
      t.targetKey,
    ),
    foreignKey({
      name: "event_values_item_fk",
      columns: [t.schoolId, t.itemDefinitionId],
      foreignColumns: [itemDefinitions.schoolId, itemDefinitions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "event_values_target_fk",
      columns: [t.schoolId, t.targetId],
      foreignColumns: [targets.schoolId, targets.id],
    }),
    check("event_values_subject_kind_check", sql`${t.subjectKind} in ('event', 'absence')`),
    check("event_values_target_check", sql`${t.targetId} is null or ${t.targetRef} is null`),
  ],
);

export type EventValueRow = typeof eventValues.$inferSelect;

/** One step of a kind template's quick-entry flow (DESIGN schedule
 *  6.5): a built-in step (the person, the location, the time band,
 *  the leave subdivision) or one of the kind's own items. An "item"
 *  step names its item definition once the school has bound one;
 *  the shipped deadline default leaves it null (its item is the
 *  school's own submission-destination definition). */
export interface KindTemplateStep {
  kind: "person" | "location" | "time" | "subdivision" | "item";
  /** The item an "item" step is bound to; null while unbound (and
   *  for the built-in steps, which name no item). The store
   *  normalizes a missing binding to null, so stored steps always
   *  carry the field. */
  itemDefinitionId: string | null;
}

/**
 * A kind template (DESIGN schedule 6.3.1 / 6.5): per event kind,
 * which items are shown, what the person is called （担当者／出張者／
 * 取得者）, what the cell display leads with (the title, the person,
 * or both), and the quick-entry step order. subject_kind records
 * where the platform stores entries of this kind: business trips
 * and leave are platform absences, not events — the template says
 * so, as Issue #29 requires. kind_code is the platform's kind code
 * within the subject (the shared event / absence kind lists);
 * steps and item_definition_ids are kept as JSON, in display order.
 */
export const kindTemplates = pgTable(
  "kind_templates",
  {
    schoolId: text("school_id").notNull(),
    id: text("id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    subjectKind: text("subject_kind").notNull(),
    kindCode: text("kind_code").notNull(),
    personLabel: text("person_label").notNull(),
    displaySource: text("display_source").notNull(),
    steps: jsonb("steps").$type<KindTemplateStep[]>().notNull(),
    itemDefinitionIds: jsonb("item_definition_ids").$type<string[]>().default([]).notNull(),
    sort: integer("sort").default(0).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("kind_templates_school_key_unique").on(t.schoolId, t.key),
    check("kind_templates_subject_kind_check", sql`${t.subjectKind} in ('event', 'absence')`),
    check(
      "kind_templates_kind_code_check",
      sql`(${t.subjectKind} = 'event' and ${t.kindCode} in ('event', 'meeting', 'exam', 'deadline', 'other'))
        or (${t.subjectKind} = 'absence' and ${t.kindCode} in ('business_trip', 'training', 'leave', 'other'))`,
    ),
    check(
      "kind_templates_display_source_check",
      sql`${t.displaySource} in ('title', 'person', 'person_title')`,
    ),
  ],
);

export type KindTemplateRow = typeof kindTemplates.$inferSelect;
