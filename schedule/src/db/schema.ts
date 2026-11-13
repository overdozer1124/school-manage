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
 * column names its duty definition by id only: duty definitions
 * are a later issue, so there is no table to key into yet (the
 * same treatment as daily_values.value_option_id, Issue #28).
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
