import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  integer,
  pgEnum,
  pgTable,
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
    unique("memberships_school_person_unique").on(t.schoolId, t.personId),
    unique("memberships_school_id_unique").on(t.schoolId, t.id),
    check("memberships_period_order", sql`${t.startsOn} <= ${t.endsOn}`),
  ],
);

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
