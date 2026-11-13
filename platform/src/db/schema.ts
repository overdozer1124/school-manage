import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
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

/**
 * The school calendar's events (Issue #24, DESIGN-INTEGRATION 2.2,
 * schedule DESIGN 4.5). The event body lives here in the platform;
 * per-kind extra fields stay in the schedule database (実装2). Like
 * the masters, an event carries the shared entity meta plus
 * created_by (3.1: who made it, and from which product). The fixed
 * codes (kind, certainty, visibility, date precision) are text
 * columns with checks, as with the day patterns; the calendar-types
 * schemas are the wire-level validation.
 *
 * The time is a CalendarTime stored in jsonb exactly as entered
 * (8-1-2). The location master lives in the schedule app, so
 * location_id is a bare string with no foreign key; the free-text
 * location is kept alongside it (schedule DESIGN 4.5).
 */
export const events = pgTable(
  "events",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    title: text("title").notNull(),
    /** The fixed kind code (calendar-types eventKindSchema). */
    kind: text("kind").notNull(),
    /** The school's own word for the kind, if it has one. */
    kindLabel: text("kind_label"),
    datePrecision: text("date_precision").notNull(),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    /** A CalendarTime as entered, or null when no time is recorded. */
    time: jsonb("time"),
    locationId: text("location_id"),
    locationText: text("location_text"),
    description: text("description"),
    certainty: text("certainty").notNull(),
    visibility: text("visibility").notNull(),
    revision: integer("revision").notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedVia: updatedViaEnum("updated_via").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    check("events_kind_check", sql`${t.kind} in ('event', 'meeting', 'exam', 'deadline', 'other')`),
    check(
      "events_date_precision_check",
      sql`${t.datePrecision} in ('day', 'range', 'month', 'undecided')`,
    ),
    check("events_certainty_check", sql`${t.certainty} in ('tentative', 'confirmed')`),
    check(
      "events_visibility_check",
      sql`${t.visibility} in ('staff_only', 'guardian', 'student', 'public')`,
    ),
    check(
      "events_period_order",
      sql`${t.endsOn} is null or ${t.startsOn} is null or ${t.endsOn} >= ${t.startsOn}`,
    ),
  ],
);

/**
 * One recorded day of the school calendar (Issue #23,
 * DESIGN-INTEGRATION 2.1, schedule DESIGN 4.1 `day_records`): what
 * kind of day a date is, the day pattern it runs on, and a weekday
 * swap when another weekday's timetable applies. A date has at most
 * one day record per school. Dates with no record are not stored:
 * they are the default day (a class day on a weekday, a closed day
 * on a weekend), which readers derive from the weekday. The pattern
 * reference is a composite foreign key to the shared day patterns,
 * so a day can never point at another school's pattern. The fixed
 * codes are text columns with checks, as with the day patterns; the
 * calendar-types schemas are the wire-level validation.
 */
export const dayRecords = pgTable(
  "day_records",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    date: date("date").notNull(),
    /** The fixed day type code (calendar-types dayTypeSchema). */
    dayType: text("day_type").notNull(),
    /** The school's own word for the day type, if it has one. */
    dayTypeLabel: text("day_type_label"),
    dayScheduleId: text("day_schedule_id"),
    weekdaySwap: text("weekday_swap"),
    note: text("note"),
    ...masterMeta,
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("day_records_school_date_unique").on(t.schoolId, t.date),
    check(
      "day_records_day_type_check",
      sql`${t.dayType} in ('class_day', 'closed_day', 'long_vacation', 'attendance_day', 'event_day')`,
    ),
    check(
      "day_records_weekday_swap_check",
      sql`${t.weekdaySwap} is null or ${t.weekdaySwap} in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')`,
    ),
    foreignKey({
      columns: [t.schoolId, t.dayScheduleId],
      foreignColumns: [dayPatterns.schoolId, dayPatterns.id],
      name: "day_records_day_pattern_fk",
    }),
  ],
);

/**
 * The holiday / closed-day list (Issue #23, schedule DESIGN 4.1
 * `holidays`), kept apart from the day records so the official list
 * can be maintained on its own. A date may carry more than one row
 * (different kinds), so the date alone is not unique; the same kind
 * may not be recorded twice for one date, though, so importing the
 * yearly list twice cannot duplicate a row.
 */
export const holidays = pgTable(
  "holidays",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    date: date("date").notNull(),
    name: text("name").notNull(),
    /** The fixed kind code (calendar-types holidayKindSchema). */
    kind: text("kind").notNull(),
    ...masterMeta,
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("holidays_school_date_kind_unique").on(t.schoolId, t.date, t.kind),
    check(
      "holidays_kind_check",
      sql`${t.kind} in ('national_holiday', 'substitute_holiday', 'school_closed_day', 'office_closed_day')`,
    ),
  ],
);

/**
 * A school's own subdivision definitions under the fixed absence
 * kinds (Issue #25, DESIGN-INTEGRATION 8-1-1): under "leave" a school
 * keeps 年休／病休／… with stable keys; under "business_trip" it may
 * keep its own wordings too. The (school_id, code, key) triple is
 * unique, and an absence names its subdivision through a composite
 * foreign key on exactly that triple, so an absence can never point
 * at another school's subdivision — or at a subdivision of a
 * different kind.
 */
export const absenceSubdivisions = pgTable(
  "absence_subdivisions",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    /** The fixed absence kind this sits under (calendar-types absenceKindSchema). */
    code: text("code").notNull(),
    /** The stable key absences refer to, unique per school and kind. */
    key: text("key").notNull(),
    /** The school's own word for the subdivision. */
    label: text("label").notNull(),
    ...masterMeta,
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("absence_subdivisions_school_code_key_unique").on(t.schoolId, t.code, t.key),
    check(
      "absence_subdivisions_code_check",
      sql`${t.code} in ('business_trip', 'training', 'leave', 'other')`,
    ),
  ],
);

/**
 * A staff absence (Issue #25, DESIGN-INTEGRATION 2.3): a staff member
 * of the shared master is away over a date range, with the time kept
 * exactly as entered (a CalendarTime in jsonb, 8-1-2). The kind is a
 * fixed code; the school-specific subdivision is named by key and
 * guarded by the composite foreign key above. The subdivision is
 * private data (DESIGN-AUTH-TENANCY 4.5) — the table holds it, and
 * the API decides who may see it.
 *
 * Certainty follows D-6: a general teacher's save is always
 * tentative, and an Editor's confirmation stamps confirmed_by /
 * confirmed_at; editing a confirmed absence as its owner returns it
 * to tentative and clears the stamps (the store enforces this).
 */
export const absences = pgTable(
  "absences",
  {
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.schoolId),
    id: text("id").notNull(),
    staffId: text("staff_id").notNull(),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    /** A CalendarTime as entered (calendar-types calendarTimeSchema). */
    time: jsonb("time").notNull(),
    /** The fixed kind code (calendar-types absenceKindSchema). */
    kind: text("kind").notNull(),
    subdivisionKey: text("subdivision_key"),
    purpose: text("purpose"),
    note: text("note"),
    /** 確定度：仮／確定 (calendar-types certaintySchema). */
    certainty: text("certainty").notNull(),
    createdBy: text("created_by").notNull(),
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    ...masterMeta,
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    check("absences_kind_check", sql`${t.kind} in ('business_trip', 'training', 'leave', 'other')`),
    check("absences_certainty_check", sql`${t.certainty} in ('tentative', 'confirmed')`),
    check("absences_period_order", sql`${t.toDate} >= ${t.fromDate}`),
    check(
      "absences_confirmation_stamps",
      sql`(${t.certainty} = 'tentative' and ${t.confirmedBy} is null and ${t.confirmedAt} is null)
        or (${t.certainty} = 'confirmed' and ${t.confirmedBy} is not null and ${t.confirmedAt} is not null)`,
    ),
    foreignKey({
      columns: [t.schoolId, t.staffId],
      foreignColumns: [staffMembers.schoolId, staffMembers.id],
      name: "absences_staff_fk",
    }),
    foreignKey({
      columns: [t.schoolId, t.kind, t.subdivisionKey],
      foreignColumns: [
        absenceSubdivisions.schoolId,
        absenceSubdivisions.code,
        absenceSubdivisions.key,
      ],
      name: "absences_subdivision_fk",
    }),
  ],
);

/**
 * The subordinate rows of an event: impacts, targets and assignees.
 * Like a day pattern's periods they carry no revision of their own —
 * the event's revision covers them, and a write replaces the whole
 * set. Each row keeps its position so the stored order round-trips.
 * Impacts and targets are kept as the calendar-types values in jsonb
 * (an EventImpact / a TargetRef), validated at the API boundary.
 */
const eventChild = {
  schoolId: text("school_id")
    .notNull()
    .references(() => schools.schoolId),
  id: text("id").notNull(),
  eventId: text("event_id").notNull(),
  position: integer("position").notNull(),
};

export const eventImpacts = pgTable(
  "event_impacts",
  {
    ...eventChild,
    impact: jsonb("impact").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("event_impacts_event_position_unique").on(t.schoolId, t.eventId, t.position),
    foreignKey({
      columns: [t.schoolId, t.eventId],
      foreignColumns: [events.schoolId, events.id],
      name: "event_impacts_event_fk",
    }),
  ],
);

export const eventTargets = pgTable(
  "event_targets",
  {
    ...eventChild,
    target: jsonb("target").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("event_targets_event_position_unique").on(t.schoolId, t.eventId, t.position),
    foreignKey({
      columns: [t.schoolId, t.eventId],
      foreignColumns: [events.schoolId, events.id],
      name: "event_targets_event_fk",
    }),
  ],
);

/**
 * An assignee is a staff member of the same school or a free-text
 * name — exactly one of the two (schedule DESIGN 4.5). The composite
 * foreign key on (school_id, staff_id) makes the database itself
 * refuse another school's staff member; a null staff_id (a free-text
 * assignee) skips the check, as foreign keys do.
 */
export const eventAssignees = pgTable(
  "event_assignees",
  {
    ...eventChild,
    staffId: text("staff_id"),
    freeTextName: text("free_text_name"),
    role: text("role"),
  },
  (t) => [
    primaryKey({ columns: [t.schoolId, t.id] }),
    unique("event_assignees_event_position_unique").on(t.schoolId, t.eventId, t.position),
    check(
      "event_assignees_one_name_check",
      sql`(${t.staffId} is null) <> (${t.freeTextName} is null)`,
    ),
    foreignKey({
      columns: [t.schoolId, t.eventId],
      foreignColumns: [events.schoolId, events.id],
      name: "event_assignees_event_fk",
    }),
    foreignKey({
      columns: [t.schoolId, t.staffId],
      foreignColumns: [staffMembers.schoolId, staffMembers.id],
      name: "event_assignees_staff_fk",
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
  "holiday",
  "event",
  "absence",
  "absence_subdivision",
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
export type DayRecordRow = typeof dayRecords.$inferSelect;
export type HolidayRow = typeof holidays.$inferSelect;
export type AbsenceRow = typeof absences.$inferSelect;
export type AbsenceSubdivisionRow = typeof absenceSubdivisions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type EventImpactRow = typeof eventImpacts.$inferSelect;
export type EventTargetRow = typeof eventTargets.$inferSelect;
export type EventAssigneeRow = typeof eventAssignees.$inferSelect;
