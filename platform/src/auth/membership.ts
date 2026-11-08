import type { Membership } from "../db/schema.js";

/**
 * Membership confirmation, ported from school-timetable's
 * services/schoolMembership.ts. The judgment itself is unchanged; only
 * the record shape differs. There, confirmation was the explicit
 * membership_approved_at column and nothing else (never inferred from a
 * password hash, a role or a teacher id). Here the explicit marker is the
 * membership status set by an administrator's approval, and DESIGN-
 * INTEGRATION 8-2-1 adds the enrolment period: a membership counts only
 * while today is inside [starts_on, ends_on] (an open end is unbounded).
 */

export const UNCONFIRMED_SCHOOL_MEMBERSHIP_MESSAGE =
  "このアカウントは学校への所属が確認されていません。学校の管理者にユーザー登録を依頼してください。生徒用の公開時間割は公開用 URL からご覧ください。";

export const AMBIGUOUS_SCHOOL_MEMBERSHIP_MESSAGE =
  "同じメールアドレスが複数の学校に登録されています。学校を指定してログインしてください。";

/** Today as a YYYY-MM-DD date string, matching the date columns. */
export function todayString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isMembershipApproved(membership: Pick<Membership, "status">): boolean {
  return membership.status === "approved";
}

export function isWithinEnrolmentPeriod(
  membership: Pick<Membership, "startsOn" | "endsOn">,
  today: string,
): boolean {
  if (membership.startsOn !== null && membership.startsOn > today) return false;
  if (membership.endsOn !== null && membership.endsOn < today) return false;
  return true;
}

/**
 * A membership the person may enter the school with: approved by an
 * administrator and inside its enrolment period. Invited, suspended and
 * out-of-period memberships never produce a session.
 */
export function isMembershipCandidate(
  membership: Pick<Membership, "status" | "startsOn" | "endsOn">,
  today: string,
): boolean {
  return isMembershipApproved(membership) && isWithinEnrolmentPeriod(membership, today);
}

export function candidateMemberships<T extends Pick<Membership, "status" | "startsOn" | "endsOn">>(
  memberships: T[],
  today: string,
): T[] {
  return memberships.filter((m) => isMembershipCandidate(m, today));
}
