import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

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
