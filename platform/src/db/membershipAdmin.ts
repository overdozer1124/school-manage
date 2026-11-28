import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { isMembershipCandidate, todayString } from "../auth/membership.js";
import type { Db } from "./client.js";
import {
  auditLog,
  memberships,
  persons,
  productRoles,
  staffMembers,
  type Membership,
  type Product,
  type Role,
} from "./schema.js";

/**
 * Membership administration (Issue #128, DESIGN-AUTH-TENANCY §0 D-2 —
 * memberships are approved by an administrator — and D-4 — roles are
 * per product —, §4.1/§4.2, DESIGN-INTEGRATION §8-2-1). A school
 * administrator invites people to their school, approves or suspends
 * the membership, changes the per-product roles, links the shared
 * staff master (teacher_id), and closes the enrolment with an end
 * date when a person leaves. Every operation is scoped to the
 * administrator's own school, refuses to remove the school's last
 * usable Admin, and is recorded in audit_log in the same transaction
 * as the change itself.
 *
 * Persons and memberships are platform-level records (a person is
 * not owned by one school), so — like the auth store — the queries
 * stay inside src/db behind this narrow interface, and every query
 * here names the school explicitly.
 */

/** The membership does not exist in this school (the routes answer 404). */
export class MembershipNotFoundError extends Error {
  constructor(membershipId: string) {
    super(`membership not found: ${membershipId}`);
    this.name = "MembershipNotFoundError";
  }
}

/**
 * The operation conflicts with the membership's current state: a
 * duplicate or overlapping enrolment, a transition the status does
 * not allow, or removing the school's last administrator (the routes
 * answer 409). The message is written for the administrator reading
 * it, as with SetupError.
 */
export class MembershipConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipConflictError";
  }
}

/**
 * The operation names something that is not in this school — a
 * teacher_id that is not one of this school's staff members (the
 * routes answer 400).
 */
export class MembershipReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipReferenceError";
  }
}

/** The input value itself is not usable (the routes answer 400). */
export class MembershipValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipValidationError";
  }
}

export interface MemberRoleView {
  product: Product;
  role: Role;
}

export interface MemberView {
  membershipId: string;
  personId: string;
  email: string;
  displayName: string;
  status: Membership["status"];
  approvedAt: Date | null;
  approvedBy: string | null;
  startsOn: string | null;
  endsOn: string | null;
  teacherId: string | null;
  roles: MemberRoleView[];
}

export interface InviteMemberInput {
  email: string;
  /** Display name for a person registered by this invite. An
   *  existing person's name is kept; when omitted for a new person,
   *  the part of the email address before "@" is used provisionally. */
  name?: string;
  roles: MemberRoleView[];
  /** Enrolment start. Defaults to today: the invitation is the start
   *  of the enrolment unless the administrator names a future start. */
  startsOn?: string;
}

export interface MembershipAdminStore {
  listMembers(schoolId: string): Promise<MemberView[]>;
  inviteMember(
    actorPersonId: string,
    schoolId: string,
    input: InviteMemberInput,
  ): Promise<MemberView>;
  approveMember(actorPersonId: string, schoolId: string, membershipId: string): Promise<MemberView>;
  suspendMember(actorPersonId: string, schoolId: string, membershipId: string): Promise<MemberView>;
  unsuspendMember(
    actorPersonId: string,
    schoolId: string,
    membershipId: string,
  ): Promise<MemberView>;
  endMember(
    actorPersonId: string,
    schoolId: string,
    membershipId: string,
    endsOn: string,
  ): Promise<MemberView>;
  setMemberRole(
    actorPersonId: string,
    schoolId: string,
    membershipId: string,
    product: Product,
    role: Role | null,
  ): Promise<MemberView>;
  setMemberTeacher(
    actorPersonId: string,
    schoolId: string,
    membershipId: string,
    teacherId: string | null,
  ): Promise<MemberView>;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

/** Date ranges overlap when neither ends before the other starts; a
 *  null bound is unbounded, matching the exclusion constraint. */
function periodsOverlap(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null,
): boolean {
  const start = (v: string | null) => v ?? "0000-01-01";
  const end = (v: string | null) => v ?? "9999-12-31";
  return start(aStart) <= end(bEnd) && start(bStart) <= end(aEnd);
}

async function loadMembership(tx: Tx, schoolId: string, membershipId: string): Promise<Membership> {
  const rows = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.schoolId, schoolId), eq(memberships.id, membershipId)))
    .limit(1);
  const membership = rows[0];
  if (!membership) throw new MembershipNotFoundError(membershipId);
  return membership;
}

async function loadView(tx: Tx, membership: Membership): Promise<MemberView> {
  const personRows = await tx
    .select()
    .from(persons)
    .where(eq(persons.id, membership.personId))
    .limit(1);
  const person = personRows[0];
  if (!person) throw new MembershipNotFoundError(membership.id);
  const roleRows = await tx
    .select()
    .from(productRoles)
    .where(eq(productRoles.membershipId, membership.id));
  return {
    membershipId: membership.id,
    personId: person.id,
    email: person.email,
    displayName: person.displayName,
    status: membership.status,
    approvedAt: membership.approvedAt,
    approvedBy: membership.approvedBy,
    startsOn: membership.startsOn,
    endsOn: membership.endsOn,
    teacherId: membership.teacherId,
    roles: roleRows
      .map((r) => ({ product: r.product, role: r.role }))
      .sort((a, b) => a.product.localeCompare(b.product)),
  };
}

async function appendAudit(
  tx: Tx,
  schoolId: string,
  actorPersonId: string,
  action: string,
  summary: string,
): Promise<void> {
  await tx.insert(auditLog).values({
    id: randomUUID(),
    schoolId,
    personId: actorPersonId,
    action,
    target: "membership",
    summary,
  });
}

/**
 * The memberships that can administer the school right now: approved,
 * inside their enrolment period today, and holding Admin in at least
 * one product. Suspending, ending or de-roling the only one of these
 * would lock the school out of its own administration, so those
 * operations refuse (D-2: administration must always be possible).
 */
async function currentAdminMembershipIds(
  tx: Tx,
  schoolId: string,
  today: string,
): Promise<Set<string>> {
  const rows = await tx.select().from(memberships).where(eq(memberships.schoolId, schoolId));
  const candidates = rows.filter((m) => isMembershipCandidate(m, today));
  if (candidates.length === 0) return new Set();
  const roleRows = await tx
    .select()
    .from(productRoles)
    .where(
      inArray(
        productRoles.membershipId,
        candidates.map((m) => m.id),
      ),
    );
  const admins = new Set<string>();
  for (const row of roleRows) {
    if (row.role === "Admin") admins.add(row.membershipId);
  }
  return admins;
}

function assertNotLastAdmin(adminIds: Set<string>, membershipId: string): void {
  if (adminIds.has(membershipId) && adminIds.size === 1) {
    throw new MembershipConflictError(
      "この学校の最後の管理者のため、この操作はできません。先に別の管理者を用意してください。",
    );
  }
}

export function createMembershipAdminStore(db: Db): MembershipAdminStore {
  return {
    async listMembers(schoolId) {
      const rows = await db
        .select()
        .from(memberships)
        .where(eq(memberships.schoolId, schoolId))
        .orderBy(asc(memberships.createdAt));
      if (rows.length === 0) return [];
      const personRows = await db
        .select()
        .from(persons)
        .where(
          inArray(
            persons.id,
            rows.map((m) => m.personId),
          ),
        );
      const personById = new Map(personRows.map((p) => [p.id, p]));
      const roleRows = await db
        .select()
        .from(productRoles)
        .where(
          inArray(
            productRoles.membershipId,
            rows.map((m) => m.id),
          ),
        );
      const rolesByMembership = new Map<string, MemberRoleView[]>();
      for (const row of roleRows) {
        const list = rolesByMembership.get(row.membershipId) ?? [];
        list.push({ product: row.product, role: row.role });
        rolesByMembership.set(row.membershipId, list);
      }
      return rows.map((m) => {
        const person = personById.get(m.personId);
        return {
          membershipId: m.id,
          personId: m.personId,
          email: person?.email ?? "",
          displayName: person?.displayName ?? "",
          status: m.status,
          approvedAt: m.approvedAt,
          approvedBy: m.approvedBy,
          startsOn: m.startsOn,
          endsOn: m.endsOn,
          teacherId: m.teacherId,
          roles: (rolesByMembership.get(m.id) ?? []).sort((a, b) =>
            a.product.localeCompare(b.product),
          ),
        };
      });
    },

    async inviteMember(actorPersonId, schoolId, input) {
      const email = input.email.trim();
      const startsOn = input.startsOn ?? todayString();
      return db.transaction(async (tx) => {
        const personRows = await tx
          .select()
          .from(persons)
          .where(sql`lower(${persons.email}) = ${email.toLowerCase()}`)
          .limit(1);
        let person = personRows[0];
        if (!person) {
          const displayName = input.name?.trim() || email.split("@")[0] || email;
          const personId = randomUUID();
          await tx.insert(persons).values({ id: personId, email, displayName });
          person = {
            id: personId,
            email,
            displayName,
            googleId: null,
            passwordHash: null,
            passwordChangeRequired: false,
            passwordScopeRestricted: false,
            passwordScopeSchoolId: null,
            createdAt: new Date(),
          };
        }

        // One row per enrolment period (Issue #14): a period that
        // overlaps an existing row of this school and person is a
        // duplicate invitation, whatever its status. The database's
        // exclusion constraint is the backstop for the same rule.
        const existing = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.schoolId, schoolId), eq(memberships.personId, person.id)));
        for (const m of existing) {
          if (periodsOverlap(m.startsOn, m.endsOn, startsOn, null)) {
            throw new MembershipConflictError(
              "この人は既にこの学校に所属しています（在籍期間が重なります）。",
            );
          }
        }

        const membershipId = randomUUID();
        try {
          await tx.insert(memberships).values({
            id: membershipId,
            schoolId,
            personId: person.id,
            status: "invited",
            startsOn,
          });
          for (const role of input.roles) {
            await tx.insert(productRoles).values({
              id: randomUUID(),
              schoolId,
              membershipId,
              product: role.product,
              role: role.role,
            });
          }
        } catch (error) {
          const code = pgCode(error);
          if (code === "23P01" || code === "23505") {
            throw new MembershipConflictError(
              "この人は既にこの学校に所属しています（在籍期間が重なります）。",
            );
          }
          throw error;
        }

        const roleSummary =
          input.roles.length > 0
            ? input.roles.map((r) => `${r.product}=${r.role}`).join("、")
            : "役割なし";
        await appendAudit(
          tx,
          schoolId,
          actorPersonId,
          "membership.invite",
          `${email} を招待（${roleSummary}）`,
        );
        return loadView(tx, await loadMembership(tx, schoolId, membershipId));
      });
    },

    async approveMember(actorPersonId, schoolId, membershipId) {
      return db.transaction(async (tx) => {
        const membership = await loadMembership(tx, schoolId, membershipId);
        if (membership.status === "approved") {
          throw new MembershipConflictError("この所属は既に承認済みです。");
        }
        if (membership.status === "suspended") {
          throw new MembershipConflictError(
            "停止中の所属は「停止の解除」で承認済みに戻してください。",
          );
        }
        await tx
          .update(memberships)
          .set({ status: "approved", approvedAt: new Date(), approvedBy: actorPersonId })
          .where(eq(memberships.id, membershipId));
        const view = await loadView(tx, await loadMembership(tx, schoolId, membershipId));
        await appendAudit(
          tx,
          schoolId,
          actorPersonId,
          "membership.approve",
          `${view.email} の所属を承認`,
        );
        return view;
      });
    },

    async suspendMember(actorPersonId, schoolId, membershipId) {
      return db.transaction(async (tx) => {
        const membership = await loadMembership(tx, schoolId, membershipId);
        if (membership.status !== "approved") {
          throw new MembershipConflictError("承認済みの所属だけを停止できます。");
        }
        const today = todayString();
        if (isMembershipCandidate(membership, today)) {
          assertNotLastAdmin(await currentAdminMembershipIds(tx, schoolId, today), membershipId);
        }
        await tx
          .update(memberships)
          .set({ status: "suspended" })
          .where(eq(memberships.id, membershipId));
        const view = await loadView(tx, await loadMembership(tx, schoolId, membershipId));
        await appendAudit(
          tx,
          schoolId,
          actorPersonId,
          "membership.suspend",
          `${view.email} の所属を停止`,
        );
        return view;
      });
    },

    async unsuspendMember(actorPersonId, schoolId, membershipId) {
      return db.transaction(async (tx) => {
        const membership = await loadMembership(tx, schoolId, membershipId);
        if (membership.status !== "suspended") {
          throw new MembershipConflictError("停止中の所属だけを停止解除できます。");
        }
        await tx
          .update(memberships)
          .set({ status: "approved" })
          .where(eq(memberships.id, membershipId));
        const view = await loadView(tx, await loadMembership(tx, schoolId, membershipId));
        await appendAudit(
          tx,
          schoolId,
          actorPersonId,
          "membership.unsuspend",
          `${view.email} の所属の停止を解除`,
        );
        return view;
      });
    },

    async endMember(actorPersonId, schoolId, membershipId, endsOn) {
      return db.transaction(async (tx) => {
        const membership = await loadMembership(tx, schoolId, membershipId);
        if (membership.startsOn !== null && endsOn < membership.startsOn) {
          throw new MembershipValidationError("終了日は開始日以降の日付にしてください。");
        }
        const today = todayString();
        if (membership.endsOn !== null && membership.endsOn < today) {
          throw new MembershipConflictError("この所属は既に終了しています。");
        }
        if (isMembershipCandidate(membership, today)) {
          assertNotLastAdmin(await currentAdminMembershipIds(tx, schoolId, today), membershipId);
        }
        await tx.update(memberships).set({ endsOn }).where(eq(memberships.id, membershipId));
        const view = await loadView(tx, await loadMembership(tx, schoolId, membershipId));
        await appendAudit(
          tx,
          schoolId,
          actorPersonId,
          "membership.end",
          `${view.email} の在籍を ${endsOn} で終了`,
        );
        return view;
      });
    },

    async setMemberRole(actorPersonId, schoolId, membershipId, product, role) {
      return db.transaction(async (tx) => {
        const membership = await loadMembership(tx, schoolId, membershipId);
        const roleRows = await tx
          .select()
          .from(productRoles)
          .where(eq(productRoles.membershipId, membershipId));
        const existing = roleRows.find((r) => r.product === product);
        if ((existing?.role ?? null) === role) {
          return loadView(tx, membership);
        }
        // Removing the Admin role (to another role, or to none) is
        // refused for the school's last usable administrator — unless
        // the same membership keeps Admin in the other product.
        const today = todayString();
        if (
          existing?.role === "Admin" &&
          role !== "Admin" &&
          isMembershipCandidate(membership, today) &&
          !roleRows.some((r) => r.product !== product && r.role === "Admin")
        ) {
          assertNotLastAdmin(await currentAdminMembershipIds(tx, schoolId, today), membershipId);
        }
        if (role === null) {
          // The no-op check above has already returned when there was
          // no row to remove, so a row exists here.
          if (existing) {
            await tx.delete(productRoles).where(eq(productRoles.id, existing.id));
          }
        } else if (existing) {
          await tx.update(productRoles).set({ role }).where(eq(productRoles.id, existing.id));
        } else {
          await tx.insert(productRoles).values({
            id: randomUUID(),
            schoolId,
            membershipId,
            product,
            role,
          });
        }
        const view = await loadView(tx, await loadMembership(tx, schoolId, membershipId));
        await appendAudit(
          tx,
          schoolId,
          actorPersonId,
          "membership.role",
          `${view.email} の ${product} の役割を ${role ?? "なし"} に変更`,
        );
        return view;
      });
    },

    async setMemberTeacher(actorPersonId, schoolId, membershipId, teacherId) {
      return db.transaction(async (tx) => {
        const membership = await loadMembership(tx, schoolId, membershipId);
        if (teacherId !== null) {
          // teacher_id names a staff member of the SAME school
          // (8-2-1). The composite foreign key is the backstop; the
          // check here answers with a reason, and it is also what
          // refuses another school's staff id.
          const staffRows = await tx
            .select()
            .from(staffMembers)
            .where(and(eq(staffMembers.schoolId, schoolId), eq(staffMembers.id, teacherId)))
            .limit(1);
          if (staffRows.length === 0) {
            throw new MembershipReferenceError("教員IDがこの学校の教職員ではありません。");
          }
        }
        if (membership.teacherId === teacherId) {
          return loadView(tx, membership);
        }
        await tx.update(memberships).set({ teacherId }).where(eq(memberships.id, membershipId));
        const view = await loadView(tx, await loadMembership(tx, schoolId, membershipId));
        await appendAudit(
          tx,
          schoolId,
          actorPersonId,
          "membership.teacher",
          `${view.email} の教員IDを ${teacherId ?? "なし"} に変更`,
        );
        return view;
      });
    },
  };
}
