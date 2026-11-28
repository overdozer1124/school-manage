import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  auditLog,
  memberships,
  persons,
  platformAdmins,
  productEntitlements,
  productRoles,
  schools,
} from "./schema.js";
import { todayString } from "../auth/membership.js";

/**
 * The first-run bootstrap (Issue #127, DESIGN-AUTH-TENANCY §0 D-2,
 * §4.1/§4.2, DESIGN-INTEGRATION §8-2-1). On an empty database nothing
 * can create the first school, person, membership or entitlement yet
 * (every API path needs a signed-in administrator), so the operator
 * runs these commands on the server instead. There is deliberately no
 * screen for this.
 *
 * Login means: the commands register the person by email only — no
 * password is generated, accepted as an argument, printed, or logged,
 * and no token is issued. This follows school-timetable's flow, where
 * an account is created with an email address and the first sign-in is
 * Google (setPassword there is an in-session operation for after that
 * first sign-in). The platform's Google login already links the
 * Google id to the person whose email Google has verified
 * (auth/service.ts loginWithGoogle), so the registered administrator
 * can sign in as soon as the command has run.
 */

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;

function requireSlug(slug: string): string {
  const value = slug.trim();
  if (!SLUG_PATTERN.test(value) || value.length > 64) {
    throw new SetupError("slug は半角小文字・数字・ハイフンで始まる64文字以内で指定してください");
  }
  return value;
}

function requireEmail(email: string): string {
  const value = email.trim();
  if (!EMAIL_PATTERN.test(value)) {
    throw new SetupError("メールアドレスの形が正しくありません");
  }
  return value;
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SetupError(`${label}を指定してください`);
  return trimmed;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function findPersonByEmail(tx: Tx, email: string) {
  const rows = await tx
    .select()
    .from(persons)
    .where(sql`lower(${persons.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return rows[0];
}

async function findOrCreatePerson(
  tx: Tx,
  email: string,
  displayName: string | undefined,
): Promise<{ personId: string; created: boolean }> {
  const existing = await findPersonByEmail(tx, email);
  if (existing) return { personId: existing.id, created: false };
  if (!displayName) {
    throw new SetupError("新しい人を登録するには名前（--name / --admin-name）が必要です");
  }
  const personId = randomUUID();
  await tx.insert(persons).values({ id: personId, email, displayName });
  return { personId, created: true };
}

export interface SetupSchoolInput {
  slug: string;
  schoolName: string;
  adminEmail: string;
  adminName?: string;
  /** Entitlement plan for the schedule product (default "standard"). */
  plan?: string;
}

export interface SetupSchoolResult {
  schoolId: string;
  slug: string;
  schoolName: string;
  adminPersonId: string;
  adminEmail: string;
  adminCreated: boolean;
  plan: string;
}

/**
 * Creates the first school and its administrator in one transaction:
 * the school, the administrator's person row (email only) with an
 * approved membership, the schedule product role Admin on that
 * membership, and an active schedule entitlement starting today. A
 * slug that is already taken refuses the whole run before anything is
 * written, so a repeated run changes nothing.
 */
export async function setupSchool(db: Db, input: SetupSchoolInput): Promise<SetupSchoolResult> {
  const slug = requireSlug(input.slug);
  const schoolName = requireText(input.schoolName, "学校名");
  const adminEmail = requireEmail(input.adminEmail);
  const plan = (input.plan ?? "standard").trim() || "standard";

  return db.transaction(async (tx) => {
    const taken = await tx.select().from(schools).where(eq(schools.slug, slug)).limit(1);
    if (taken.length > 0) {
      throw new SetupError(`slug "${slug}" は既に使われています`);
    }

    const admin = await findOrCreatePerson(tx, adminEmail, input.adminName?.trim() || undefined);

    const schoolId = randomUUID();
    await tx.insert(schools).values({ schoolId, slug, name: schoolName });

    const membershipId = randomUUID();
    await tx.insert(memberships).values({
      id: membershipId,
      schoolId,
      personId: admin.personId,
      status: "approved",
      approvedAt: new Date(),
    });

    await tx.insert(productRoles).values({
      id: randomUUID(),
      schoolId,
      membershipId,
      product: "schedule",
      role: "Admin",
    });

    await tx.insert(productEntitlements).values({
      id: randomUUID(),
      schoolId,
      product: "schedule",
      plan,
      status: "active",
      startsOn: todayString(),
    });

    await tx.insert(auditLog).values({
      id: randomUUID(),
      schoolId,
      personId: admin.personId,
      action: "setup.school",
      target: "school",
      summary: `最初の学校を作成（slug=${slug}、管理者=${adminEmail}）`,
    });

    return {
      schoolId,
      slug,
      schoolName,
      adminPersonId: admin.personId,
      adminEmail,
      adminCreated: admin.created,
      plan,
    };
  });
}

export interface SetupPlatformAdminInput {
  email: string;
  /** Required when the email does not belong to an existing person. */
  name?: string;
}

export interface SetupPlatformAdminResult {
  personId: string;
  email: string;
  personCreated: boolean;
}

/**
 * Adds a person to platform_admins (the platform operators), in the
 * same shape as setupSchool: the person is found by email or
 * registered with email only, and a person who is already an operator
 * is refused without changing anything.
 */
export async function setupPlatformAdmin(
  db: Db,
  input: SetupPlatformAdminInput,
): Promise<SetupPlatformAdminResult> {
  const email = requireEmail(input.email);

  return db.transaction(async (tx) => {
    const person = await findOrCreatePerson(tx, email, input.name?.trim() || undefined);

    const existing = await tx
      .select()
      .from(platformAdmins)
      .where(eq(platformAdmins.personId, person.personId))
      .limit(1);
    if (existing.length > 0) {
      throw new SetupError(`${email} は既に運営者として登録されています`);
    }

    await tx.insert(platformAdmins).values({ personId: person.personId });

    await tx.insert(auditLog).values({
      id: randomUUID(),
      personId: person.personId,
      action: "setup.platform_admin",
      target: "platform_admin",
      summary: `運営者を追加（${email}）`,
    });

    return { personId: person.personId, email, personCreated: person.created };
  });
}
