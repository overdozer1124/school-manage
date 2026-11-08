import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  auditLog,
  memberships,
  persons,
  platformAdmins,
  schools,
  type Membership,
  type Person,
  type School,
} from "./schema.js";

/**
 * Data access for the login flow (Issue #5). Persons and memberships are
 * platform-level records (a person is not owned by one school), so they
 * cannot go through tenantDb; like every other raw-client use, the queries
 * themselves stay inside src/db and the auth layer works against this
 * narrow store interface.
 */
export interface AuthStore {
  findPersonByEmail(email: string): Promise<Person | undefined>;
  findPersonByGoogleId(googleId: string): Promise<Person | undefined>;
  findPersonById(id: string): Promise<Person | undefined>;
  listMemberships(personId: string): Promise<Membership[]>;
  findSchool(schoolId: string): Promise<School | undefined>;
  findSchoolBySlug(slug: string): Promise<School | undefined>;
  findSchoolsByIds(schoolIds: string[]): Promise<School[]>;
  isPlatformAdmin(personId: string): Promise<boolean>;
  linkGoogleId(personId: string, googleId: string): Promise<void>;
  appendAudit(entry: {
    schoolId?: string | null;
    personId?: string | null;
    action: string;
    target: string;
    summary: string;
  }): Promise<void>;
}

export function createAuthStore(db: Db): AuthStore {
  return {
    async findPersonByEmail(email) {
      const rows = await db
        .select()
        .from(persons)
        .where(sql`lower(${persons.email}) = ${email.toLowerCase()}`)
        .limit(1);
      return rows[0];
    },

    async findPersonByGoogleId(googleId) {
      const rows = await db.select().from(persons).where(eq(persons.googleId, googleId)).limit(1);
      return rows[0];
    },

    async findPersonById(id) {
      const rows = await db.select().from(persons).where(eq(persons.id, id)).limit(1);
      return rows[0];
    },

    async listMemberships(personId) {
      return db.select().from(memberships).where(eq(memberships.personId, personId));
    },

    async findSchool(schoolId) {
      const rows = await db.select().from(schools).where(eq(schools.schoolId, schoolId)).limit(1);
      return rows[0];
    },

    async findSchoolBySlug(slug) {
      const rows = await db.select().from(schools).where(eq(schools.slug, slug)).limit(1);
      return rows[0];
    },

    async findSchoolsByIds(schoolIds) {
      if (schoolIds.length === 0) return [];
      return db.select().from(schools).where(inArray(schools.schoolId, schoolIds));
    },

    async isPlatformAdmin(personId) {
      const rows = await db
        .select()
        .from(platformAdmins)
        .where(eq(platformAdmins.personId, personId))
        .limit(1);
      return rows.length > 0;
    },

    async linkGoogleId(personId, googleId) {
      await db.update(persons).set({ googleId }).where(eq(persons.id, personId));
    },

    async appendAudit(entry) {
      await db.insert(auditLog).values({
        id: randomUUID(),
        schoolId: entry.schoolId ?? null,
        personId: entry.personId ?? null,
        action: entry.action,
        target: entry.target,
        summary: entry.summary,
      });
    },
  };
}
