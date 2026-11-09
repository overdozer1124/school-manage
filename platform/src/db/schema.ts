import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";

/**
 * Platform (shared foundation) schema. Tenancy rules
 * (DESIGN-AUTH-TENANCY 3.1 / 3.3, DESIGN-INTEGRATION 8-2-1):
 * - Every school-owned table carries school_id.
 * - Uniqueness is per school, and children reference their parent through
 *   a composite (school_id, parent_id) foreign key, so the database
 *   itself refuses a cross-school reference.
 * - "Person" (login identity) and "membership" (person x school) are
 *   separate tables, so one person can belong to several schools.
 */

export const membershipStatusEnum = pgEnum("membership_status", [
  "invited",
  "approved",
  "suspended",
]);
export const productEnum = pgEnum("product", ["schedule", "timetable"]);
export const roleEnum = pgEnum("product_role", ["Admin", "Editor", "Viewer"]);
export const entitlementStatusEnum = pgEnum("entitlement_status", [
  "active",
  "suspended",
  "cancelled",
]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const schools = pgTable("schools", {
  schoolId: text("school_id").primaryKey(),
  slug: text("slug").unique(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const persons = pgTable(
  "persons",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    googleId: text("google_id").unique(),
    passwordHash: text("password_hash"),
    createdAt: createdAt(),
  },
  // Email identity is case-insensitive: uniqueness is on lower(email),
  // so "A@x.jp" and "a@x.jp" cannot become two different persons.
  (t) => [uniqueIndex("persons_email_lower_unique").on(sql`lower(${t.email})`)],
);

/** Which side a write came from (DESIGN-INTEGRATION 3.1: updated_via). */
export const updatedViaEnum = pgEnum("updated_via", ["platform", "schedule", "timetable"]);

/**
 * The shared masters (Issue #22, DESIGN-INTEGRATION 2.4): staff,
 * grades, classes, special-needs classes, and the day patterns with
 * their periods. Both products read and write them through the
 * platform API; neither product keeps its own copy. Every master
 * carries the shared entity meta (revision for the optimistic lock,
 * updated_by / updated_via — 3.1), and children reference their
 * parent through a composite (school_id, parent_id) key, so a class
 * can never point at another school's grade.
 */
const masterMeta = {
  revision: integer("revision").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedVia: updatedViaEnum("updated_via").notNull(),
  createdAt: createdAt(),
};

export const staffMembers = pgTable(
  "staff_members",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    name: text("name").notNull(),
    shortName: text("short_name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    active: boolean("active").notNull().default(true),
    personId: text("person_id").references(() => persons.id),
    ...masterMeta,
  },
  // The primary key is (school_id, id), as in the timetable: an id is
  // unique within its school only, so two schools may use the same id
  // without colliding — or revealing each other's ids (Issue #22).
  (t) => [primaryKey({ columns: [t.schoolId, t.id] })],
);

export const grades = pgTable(
  "grades",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    /** The school's grouping of grades （前期課程など）, if any. */
    stage: text("stage"),
    ...masterMeta,
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.id] })],
);

export const classes = pgTable(
  "classes",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    gradeId: text("grade_id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    ...masterMeta,
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    foreignKey({
      columns: [t.schoolId, t.gradeId],
      foreignColumns: [grades.schoolId, grades.id],
      name: "classes_grade_fk",
    }),
  ],
);

export const specialNeedsClasses = pgTable(
  "special_needs_classes",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    ...masterMeta,
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.id] })],
);

export const dayPatterns = pgTable(
  "day_patterns",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    /**
     * The fixed meaning of the pattern (calendar-types
     * dayScheduleKind); the check keeps direct writes honest too.
     */
    kind: text("kind").notNull(),
    /** The school's own short code for the pattern (A, B, 普, A7…). */
    code: text("code").notNull(),
    name: text("name").notNull(),
    ...masterMeta,
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("day_patterns_school_code_unique").on(t.schoolId, t.code),
    check("day_patterns_kind_check", sql`${t.kind} in ('normal', 'shortened', 'exam', 'special')`),
  ],
);

/**
 * The periods of a day pattern. Periods are subordinate rows: they
 * are replaced wholesale when the pattern is updated, so they carry
 * no revision of their own — the pattern's revision covers them.
 * period is the pattern-local number; the out-of-range bands are
 * ordinary rows (0 = morning, 99 = after school).
 */
export const dayPatternPeriods = pgTable(
  "day_pattern_periods",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    dayPatternId: text("day_pattern_id").notNull(),
    period: integer("period").notNull(),
    label: text("label").notNull(),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("day_pattern_periods_pattern_period_unique").on(t.schoolId, t.dayPatternId, t.period),
    foreignKey({
      columns: [t.schoolId, t.dayPatternId],
      foreignColumns: [dayPatterns.schoolId, dayPatterns.id],
      name: "day_pattern_periods_pattern_fk",
    }),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    personId: text("person_id")
      .notNull()
      .references(() => persons.id),
    status: membershipStatusEnum("status").notNull().default("invited"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    teacherId: text("teacher_id"),
    createdAt: createdAt(),
  },
  (t) => [
    // One row per enrolment period (Issue #14): a person who returns
    // to a school gets a new row and the old period stays on record.
    // Overlapping periods for the same school and person are refused
    // by the memberships_no_overlap_period exclusion constraint,
    // which migration 0002 adds in raw SQL (drizzle cannot model
    // exclusion constraints).
    unique("memberships_school_id_unique").on(t.schoolId, t.id),
    check("memberships_period_order", sql`${t.startsOn} <= ${t.endsOn}`),
    // teacher_id names a staff member of the SAME school (8-2-1):
    // the composite key makes the database itself refuse another
    // school's staff id (Issue #22).
    foreignKey({
      columns: [t.schoolId, t.teacherId],
      foreignColumns: [staffMembers.schoolId, staffMembers.id],
      name: "memberships_teacher_fk",
    }),
  ],
);

// Roles attach to a membership row, not to the person (Issue #14):
// when a person returns to a school on a new membership row, roles
// are granted on the new row; the old row's roles stay as its record
// and are not copied over automatically.
export const productRoles = pgTable(
  "product_roles",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id").notNull(),
    membershipId: text("membership_id").notNull(),
    product: productEnum("product").notNull(),
    role: roleEnum("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("product_roles_membership_product_unique").on(t.membershipId, t.product),
    unique("product_roles_school_id_unique").on(t.schoolId, t.id),
    foreignKey({
      columns: [t.schoolId, t.membershipId],
      foreignColumns: [memberships.schoolId, memberships.id],
      name: "product_roles_membership_fk",
    }),
  ],
);

/** Platform operators (SuperAdmin). Separate from any school role. */
export const platformAdmins = pgTable("platform_admins", {
  personId: text("person_id")
    .primaryKey()
    .references(() => persons.id),
  createdAt: createdAt(),
});

export const productEntitlements = pgTable(
  "product_entitlements",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    product: productEnum("product").notNull(),
    plan: text("plan").notNull(),
    status: entitlementStatusEnum("status").notNull().default("active"),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("product_entitlements_school_id_unique").on(t.schoolId, t.id),
    check("product_entitlements_period_order", sql`${t.startsOn} <= ${t.endsOn}`),
  ],
);

export const schoolYears = pgTable(
  "school_years",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    year: integer("year").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    termSystem: text("term_system").notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("school_years_school_year_unique").on(t.schoolId, t.year),
    unique("school_years_school_id_unique").on(t.schoolId, t.id),
    check("school_years_period_order", sql`${t.startsOn} <= ${t.endsOn}`),
  ],
);

export const terms = pgTable(
  "terms",
  {
    id: text("id").primaryKey(),
    schoolId: text("school_id").notNull(),
    schoolYearId: text("school_year_id").notNull(),
    name: text("name").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    sort: integer("sort").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("terms_school_id_unique").on(t.schoolId, t.id),
    check("terms_period_order", sql`${t.startsOn} <= ${t.endsOn}`),
    foreignKey({
      columns: [t.schoolId, t.schoolYearId],
      foreignColumns: [schoolYears.schoolId, schoolYears.id],
      name: "terms_school_year_fk",
    }),
  ],
);

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  schoolId: text("school_id"),
  personId: text("person_id"),
  action: text("action").notNull(),
  target: text("target").notNull(),
  summary: text("summary").notNull(),
  createdAt: createdAt(),
});

/** Entity kinds a change event can be about (calendar-types events.ts). */
export const changeKindEnum = pgEnum("change_entity_kind", [
  "day",
  "event",
  "absence",
  "staff",
  "grade",
  "class",
  "special_needs_class",
  "day_pattern",
]);
export const changeOpEnum = pgEnum("change_op", ["upsert", "delete"]);

/**
 * The change outbox (Issue #21, DESIGN-INTEGRATION 3.2 / 7.1): one row
 * per change to the school calendar or the shared masters, written in
 * the same transaction as the change itself (see src/db/changes.ts).
 * `seq` is a platform-wide sequence number; products remember the last
 * seq they processed and refetch the rest through
 * GET /platform/api/v1/changes. Like audit_log this is an append-only
 * record, so school_id carries no foreign key.
 */
export const outbox = pgTable(
  "outbox",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    schoolId: text("school_id").notNull(),
    kind: changeKindEnum("kind").notNull(),
    entityId: text("entity_id").notNull(),
    revision: integer("revision").notNull(),
    op: changeOpEnum("op").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorVia: updatedViaEnum("actor_via").notNull(),
  },
  (t) => [index("outbox_school_seq_index").on(t.schoolId, t.seq)],
);

export type School = typeof schools.$inferSelect;
export type Person = typeof persons.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type ProductRole = typeof productRoles.$inferSelect;
export type ProductEntitlement = typeof productEntitlements.$inferSelect;
export type Product = (typeof productEnum.enumValues)[number];
export type Role = (typeof roleEnum.enumValues)[number];
export type OutboxRow = typeof outbox.$inferSelect;
export type StaffRow = typeof staffMembers.$inferSelect;
export type GradeRow = typeof grades.$inferSelect;
export type ClassRow = typeof classes.$inferSelect;
export type SpecialNeedsClassRow = typeof specialNeedsClasses.$inferSelect;
export type DayPatternRow = typeof dayPatterns.$inferSelect;
export type DayPatternPeriodRow = typeof dayPatternPeriods.$inferSelect;
