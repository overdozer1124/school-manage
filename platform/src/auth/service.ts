import type { AuthStore } from "../db/authStore.js";
import type { Membership, Person, Product, Role, School } from "../db/schema.js";
import type { AuthConfig } from "./config.js";
import { AuthError } from "./errors.js";
import type { GoogleAuthClient } from "./google.js";
import {
  candidateMemberships,
  isMembershipCandidate,
  todayString,
  UNCONFIRMED_SCHOOL_MEMBERSHIP_MESSAGE,
} from "./membership.js";
import { createLoginOAuthState, parseLoginOAuthState } from "./oauthState.js";
import {
  hashPassword,
  signPasswordChangeToken,
  signSelectionToken,
  signSessionToken,
  verifyPassword,
  type SessionClaims,
} from "./tokens.js";

/**
 * The login flow itself (Issue #5), ported from school-timetable's
 * routers/auth.ts with tRPC replaced by plain function calls that throw
 * AuthError(status, message). The membership judgments are the source's:
 * only a confirmed (here: approved and in-period) membership may enter a
 * school, and an unconfirmed one is never handed a token or school data.
 *
 * Where the models differ, the Issue text wins: the person authenticates
 * first, then chooses a school (8-2-1). One candidate is chosen
 * automatically; several are returned for the selection step, completed
 * by selectSchool(). A signed-in person can also re-run selectSchool()
 * to switch schools.
 */

export interface SchoolSummary {
  schoolId: string;
  name: string;
  slug: string | null;
}

export interface PersonSummary {
  id: string;
  name: string;
  email: string;
}

export type LoginResult =
  | {
      kind: "session";
      token: string;
      user: PersonSummary;
      school: SchoolSummary;
    }
  | {
      kind: "selection";
      selectionToken: string;
      user: PersonSummary;
      schools: SchoolSummary[];
    }
  | {
      // The credentials were right, but the password was set by an
      // administrator (Issue #140): no session and no school choice
      // until the person changes it. The change token is the only
      // thing this login hands out.
      kind: "password-change";
      changeToken: string;
      user: PersonSummary;
    };

interface Ctx {
  store: AuthStore;
  config: AuthConfig;
}

function personSummary(person: Person): PersonSummary {
  return { id: person.id, name: person.displayName, email: person.email };
}

function schoolSummary(school: School): SchoolSummary {
  return { schoolId: school.schoolId, name: school.name, slug: school.slug };
}

async function audit(
  ctx: Ctx,
  entry: { schoolId?: string | null; personId?: string | null; action: string; summary: string },
): Promise<void> {
  // Auditing must never break the login itself; the record is a log, not
  // part of the credential check. Summaries carry reasons only — never a
  // password, a token or a Google code.
  try {
    await ctx.store.appendAudit({ ...entry, target: "auth" });
  } catch {
    /* best effort */
  }
}

async function issueForCandidates(
  ctx: Ctx,
  person: Person,
  candidates: Membership[],
  requestedSchoolId: string | undefined,
  successAction: string,
): Promise<LoginResult> {
  const bySchool = new Map<string, Membership>();
  for (const m of candidates) bySchool.set(m.schoolId, m);

  const issueSession = async (membership: Membership): Promise<LoginResult> => {
    const school = await ctx.store.findSchool(membership.schoolId);
    if (!school) throw new AuthError(500, "学校が見つかりません");
    const token = signSessionToken(ctx.config, {
      personId: person.id,
      schoolId: school.schoolId,
      email: person.email,
    });
    await audit(ctx, {
      schoolId: school.schoolId,
      personId: person.id,
      action: successAction,
      summary: "ログイン成功",
    });
    return { kind: "session", token, user: personSummary(person), school: schoolSummary(school) };
  };

  if (requestedSchoolId) {
    const membership = bySchool.get(requestedSchoolId);
    if (!membership) {
      await audit(ctx, {
        personId: person.id,
        action: "auth.login.failure",
        summary: "指定された学校の所属が確認できない",
      });
      throw new AuthError(403, UNCONFIRMED_SCHOOL_MEMBERSHIP_MESSAGE);
    }
    return issueSession(membership);
  }

  if (candidates.length === 0) {
    await audit(ctx, {
      personId: person.id,
      action: "auth.login.failure",
      summary: "所属が確認できない",
    });
    throw new AuthError(403, UNCONFIRMED_SCHOOL_MEMBERSHIP_MESSAGE);
  }
  if (candidates.length === 1) {
    return issueSession(candidates[0] as Membership);
  }

  const schools = await ctx.store.findSchoolsByIds(candidates.map((m) => m.schoolId));
  const schoolById = new Map(schools.map((s) => [s.schoolId, s]));
  await audit(ctx, {
    personId: person.id,
    action: successAction,
    summary: "ログイン成功（学校の選択待ち）",
  });
  return {
    kind: "selection",
    selectionToken: signSelectionToken(ctx.config, person.id),
    user: personSummary(person),
    schools: candidates
      .map((m) => schoolById.get(m.schoolId))
      .filter((s): s is School => s !== undefined)
      .map(schoolSummary),
  };
}

async function candidatesFor(ctx: Ctx, personId: string): Promise<Membership[]> {
  const memberships = await ctx.store.listMemberships(personId);
  return candidateMemberships(memberships, todayString());
}

export async function loginWithPassword(
  ctx: Ctx,
  input: { email: string; password: string; schoolId?: string },
): Promise<LoginResult> {
  const person = await ctx.store.findPersonByEmail(input.email);
  if (!person) {
    await audit(ctx, {
      action: "auth.login.failure",
      summary: "メールアドレスまたはパスワードが正しくない",
    });
    throw new AuthError(401, "メールアドレスまたはパスワードが正しくありません");
  }
  if (!person.passwordHash) {
    await audit(ctx, {
      personId: person.id,
      action: "auth.login.failure",
      summary: "パスワードが設定されていない",
    });
    throw new AuthError(401, "パスワードが設定されていません。管理者に連絡してください。");
  }
  const ok = await verifyPassword(input.password, person.passwordHash);
  if (!ok) {
    await audit(ctx, {
      personId: person.id,
      action: "auth.login.failure",
      summary: "メールアドレスまたはパスワードが正しくない",
    });
    throw new AuthError(401, "メールアドレスまたはパスワードが正しくありません");
  }

  // A password an administrator chose is a hand-over, not the
  // person's own credential (Issue #140): it authenticates the
  // person for exactly one purpose — changing it — and never
  // reaches a school, whichever school was requested. This is what
  // keeps it from opening another school the person later joins:
  // the administrator who set it gets no further than this step.
  if (person.passwordChangeRequired) {
    await audit(ctx, {
      personId: person.id,
      action: "auth.login.password_change_required",
      summary: "管理者が設定したパスワードのため、本人の変更が必要",
    });
    return {
      kind: "password-change",
      changeToken: signPasswordChangeToken(ctx.config, person.id),
      user: personSummary(person),
    };
  }

  const candidates = await candidatesFor(ctx, person.id);
  return issueForCandidates(
    ctx,
    person,
    candidates,
    input.schoolId?.trim() || undefined,
    "auth.login.success",
  );
}

export function buildGoogleAuthUrl(
  ctx: Ctx,
  input: { redirectUri: string; schoolId?: string; binding?: string },
): { authUrl: string; state: string; schoolId: string | null } {
  const { googleClientId, googleClientSecret } = ctx.config;
  if (!googleClientId || !googleClientSecret) {
    const missing: string[] = [];
    if (!googleClientId) missing.push("GOOGLE_CLIENT_ID");
    if (!googleClientSecret) missing.push("GOOGLE_CLIENT_SECRET");
    throw new AuthError(
      500,
      `Google OAuth設定が完了していません。環境変数 ${missing.join(" と ")} が設定されていません。.envファイルを確認してください。`,
    );
  }
  if (!input.redirectUri.startsWith("http")) {
    throw new AuthError(400, `無効なリダイレクトURIです: ${input.redirectUri}`);
  }
  const schoolId = input.schoolId?.trim() || undefined;
  const state = createLoginOAuthState(ctx.config.jwtSecret, schoolId, input.binding);
  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return {
    authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    state,
    schoolId: schoolId ?? null,
  };
}

export async function loginWithGoogle(
  ctx: Ctx & { google: GoogleAuthClient },
  input: { code: string; state: string; redirectUri: string; schoolId?: string },
  binding: string | null,
): Promise<LoginResult> {
  // The signed state is verified before anything else, so a tampered or
  // swapped school id is refused early (source order, R6). Issue #16
  // adds the age check inside the parse and the browser binding: the
  // state must have been created for the browser presenting it, which
  // the caller proves with the binding cookie it set at /google/url
  // time. No cookie, no login.
  if (!binding) {
    throw new AuthError(
      403,
      "認証 state がこのブラウザで作られたものではありません。再度ログインしてください。",
    );
  }
  const stateParts = parseLoginOAuthState(ctx.config.jwtSecret, input.state, {
    expectedBinding: binding,
  });
  const schoolIdFromState = stateParts.schoolId;
  if (input.schoolId?.trim() && schoolIdFromState && input.schoolId.trim() !== schoolIdFromState) {
    throw new AuthError(403, "学校の指定が認証 state と一致しません");
  }

  let profile;
  try {
    const { idToken } = await ctx.google.exchangeCode(input.code, input.redirectUri);
    profile = await ctx.google.verifyIdToken(idToken);
  } catch {
    await audit(ctx, { action: "auth.google_login.failure", summary: "Google認証に失敗" });
    throw new AuthError(500, "Googleログインに失敗しました");
  }
  if (!profile.googleId) {
    throw new AuthError(400, "Google IDが取得できませんでした");
  }

  // Registered and confirmed only (source: resolveConfirmedSchoolUser-
  // ForGoogleLogin). Look the person up by Google id (the stable
  // subject) first. The email address may only be used when Google has
  // verified the person owns it (email_verified): an unverified email
  // can belong to somebody else, and matching on it would hand over
  // that person's account.
  let person = await ctx.store.findPersonByGoogleId(profile.googleId);
  if (!person && (!profile.email || !profile.emailVerified)) {
    await audit(ctx, {
      action: "auth.google_login.failure",
      summary: "メールアドレスが確認されていない",
    });
    throw new AuthError(403, UNCONFIRMED_SCHOOL_MEMBERSHIP_MESSAGE);
  }
  if (!person) {
    person = await ctx.store.findPersonByEmail(profile.email as string);
  }
  if (!person) {
    await audit(ctx, {
      action: "auth.google_login.failure",
      summary: "登録されていないアカウント",
    });
    throw new AuthError(403, UNCONFIRMED_SCHOOL_MEMBERSHIP_MESSAGE);
  }

  // Platform operators do not use Google login (source rule), unless the
  // deployment explicitly allows it.
  if (!ctx.config.allowSuperAdminGoogleLogin && (await ctx.store.isPlatformAdmin(person.id))) {
    await audit(ctx, {
      personId: person.id,
      action: "auth.google_login.failure",
      summary: "運営者はGoogleログイン不可",
    });
    throw new AuthError(
      403,
      "スーパー管理者はGoogleログインを利用できません。メールアドレスとパスワードでログインしてください。通常の学校の画面でGoogleを使うには、その学校の管理者にあなたのメールでユーザーを追加してもらってください。",
    );
  }

  // Attach the Google id on first use; a failure here does not block the
  // login (source behaviour).
  if (!person.googleId && profile.googleId) {
    try {
      await ctx.store.linkGoogleId(person.id, profile.googleId);
    } catch {
      /* optional field */
    }
  }

  // The passwordChangeRequired mark (Issue #140) does not gate this
  // path: it restricts the password credential, and Google login is
  // the person's own identity proof — the administrator who set the
  // password holds nothing here. A self-service password change in
  // the session this login opens clears the mark.
  const candidates = await candidatesFor(ctx, person.id);
  return issueForCandidates(
    ctx,
    person,
    candidates,
    schoolIdFromState ?? (input.schoolId?.trim() || undefined),
    "auth.google_login.success",
  );
}

/**
 * Exchanges a selection token (or an existing session) for a session in
 * the chosen school. The school must be one of the person's current
 * candidates; anything else is the unconfirmed-membership refusal.
 */
export async function selectSchool(
  ctx: Ctx,
  personId: string,
  schoolId: string,
): Promise<Extract<LoginResult, { kind: "session" }>> {
  const person = await ctx.store.findPersonById(personId);
  if (!person) throw new AuthError(401, "認証が必要です");
  const candidates = await candidatesFor(ctx, person.id);
  const result = await issueForCandidates(ctx, person, candidates, schoolId, "auth.school_select");
  if (result.kind !== "session") throw new AuthError(403, UNCONFIRMED_SCHOOL_MEMBERSHIP_MESSAGE);
  return result;
}

export interface MeResult {
  user: PersonSummary;
  school: SchoolSummary;
  teacherId: string | null;
}

/**
 * The current session's identity. The membership is re-checked on every
 * call (source: getUserFromToken refuses a token whose membership is no
 * longer confirmed), so a suspension or a period end invalidates an
 * existing token without waiting for its expiry.
 */
export async function getMe(ctx: Ctx, claims: SessionClaims): Promise<MeResult> {
  const person = await ctx.store.findPersonById(claims.personId);
  if (!person) throw new AuthError(401, "認証が必要です");
  const candidates = await candidatesFor(ctx, person.id);
  const membership = candidates.find((m) => m.schoolId === claims.schoolId);
  if (!membership) throw new AuthError(401, "認証が必要です");
  const school = await ctx.store.findSchool(claims.schoolId);
  if (!school) throw new AuthError(401, "認証が必要です");
  return {
    user: personSummary(person),
    school: schoolSummary(school),
    teacherId: membership.teacherId,
  };
}

export interface AuthContextResult {
  /** The platform's person id (the products' userId). */
  userId: string;
  schoolId: string;
  product: Product;
  role: Role;
  isSuperAdmin: boolean;
  teacherId: string | null;
}

const PRODUCTS: readonly Product[] = ["schedule", "timetable"];

/**
 * The authorization context a product service asks for (Issue #6,
 * DESIGN-AUTH-TENANCY 4.1): the caller has already verified the session
 * token, so an unknown person is 401, while everything the token is
 * not entitled to — an unapproved or out-of-period membership, a
 * missing product role, a stopped or out-of-period entitlement — is
 * 403. The client distinguishes the two (4.8): 401 sends the person to
 * the login page, 403 shows "no permission".
 */
export async function getAuthContext(
  ctx: Ctx,
  claims: SessionClaims,
  productParam: string,
): Promise<AuthContextResult> {
  if (!PRODUCTS.includes(productParam as Product)) {
    throw new AuthError(400, "製品の指定が正しくありません");
  }
  const product = productParam as Product;

  const person = await ctx.store.findPersonById(claims.personId);
  if (!person) throw new AuthError(401, "認証が必要です");

  const candidates = await candidatesFor(ctx, person.id);
  const membership = candidates.find((m) => m.schoolId === claims.schoolId);
  if (!membership) throw new AuthError(403, "権限がありません");

  const roleRow = await ctx.store.findProductRole(membership.id, product);
  if (!roleRow) throw new AuthError(403, "権限がありません");

  // The store returns only an entitlement in force today (active and
  // in period); a school with no such row is not entitled, whatever
  // old or future rows it may also hold.
  const entitlement = await ctx.store.findValidEntitlement(claims.schoolId, product, todayString());
  if (!entitlement) throw new AuthError(403, "権限がありません");

  return {
    userId: person.id,
    schoolId: claims.schoolId,
    product,
    role: roleRow.role,
    isSuperAdmin: await ctx.store.isPlatformAdmin(person.id),
    teacherId: membership.teacherId,
  };
}

/**
 * Sets a person's password (Issue #128): the setPassword of
 * school-timetable's routers/auth.ts, ported to HTTP+JSON. This is
 * the last step of the invited person's first-login flow — they sign
 * in first (Google, once an administrator has approved the
 * membership), then set the password that the password login uses.
 *
 * The judgments are the source's, adapted to the person/membership
 * split (8-2-1), where the password belongs to the person, not to a
 * school row:
 * - A session is required; a person sets their own password.
 * - Another person's password may be reset only by an administrator
 *   of the session's school (Admin in either product) or by a
 *   platform operator, and never for a platform operator (the
 *   source's SuperAdmin rule). For a school administrator there is a
 *   further condition, because the password belongs to the person
 *   and not to a school row: the reset is allowed only when every
 *   membership the target holds — approved or not, current or long
 *   ended — is at the administrator's own school. A person who also
 *   belongs (or once belonged) to another school is refused,
 *   otherwise an invitation to this school would hand its
 *   administrator the person's password at the other school too.
 * - When a password already exists, changing it as its owner needs
 *   the current password; an administrator's reset may omit it (when
 *   one is supplied, it must verify).
 * - A reset by somebody else marks the person
 *   passwordChangeRequired (Issue #140): the password belongs to
 *   the person, so the copy the administrator knows must not stay
 *   usable — the next password login may only change it (see
 *   loginWithPassword). A change by the person themselves clears
 *   the mark.
 * The password itself is never audited or logged — only the fact.
 */
export async function setPassword(
  ctx: Ctx,
  claims: SessionClaims,
  input: { personId?: string; currentPassword?: string; newPassword: string },
): Promise<{ success: true }> {
  const targetId = input.personId ?? claims.personId;
  const target = await ctx.store.findPersonById(targetId);
  if (!target) throw new AuthError(404, "ユーザーが見つかりません");
  const isSelf = targetId === claims.personId;

  if (!isSelf) {
    const callerIsOperator = await ctx.store.isPlatformAdmin(claims.personId);
    if (!callerIsOperator) {
      const today = todayString();
      const callerMemberships = await ctx.store.listMemberships(claims.personId);
      const callerMembership = callerMemberships.find(
        (m) => m.schoolId === claims.schoolId && isMembershipCandidate(m, today),
      );
      let callerIsAdmin = false;
      if (callerMembership) {
        for (const product of PRODUCTS) {
          const role = await ctx.store.findProductRole(callerMembership.id, product);
          if (role?.role === "Admin") {
            callerIsAdmin = true;
            break;
          }
        }
      }
      if (!callerIsAdmin) throw new AuthError(403, "この操作を実行する権限がありません");
      const targetMemberships = await ctx.store.listMemberships(targetId);
      if (!targetMemberships.some((m) => m.schoolId === claims.schoolId)) {
        throw new AuthError(404, "ユーザーが見つかりません");
      }
      // listMemberships returns every membership regardless of
      // status or period, which is exactly what this judgment needs:
      // the password is the person's alone (8-2-1), so a membership
      // anywhere else — an approved second post, an enrolment that
      // ended years ago, an invitation not yet approved — means a
      // reset here would reach that other school as well.
      if (targetMemberships.some((m) => m.schoolId !== claims.schoolId)) {
        throw new AuthError(403, "他の学校にも所属している人のパスワードは変更できません");
      }
      if (await ctx.store.isPlatformAdmin(targetId)) {
        throw new AuthError(403, "運営者のパスワードは運営者だけが変更できます");
      }
    }
  }

  if (target.passwordHash) {
    if (isSelf || input.currentPassword !== undefined) {
      if (input.currentPassword === undefined) {
        throw new AuthError(400, "現在のパスワードを入力してください");
      }
      const ok = await verifyPassword(input.currentPassword, target.passwordHash);
      if (!ok) throw new AuthError(401, "現在のパスワードが正しくありません");
    }
    // An administrator resetting another member's password may omit
    // the current password (source behaviour).
  }

  await ctx.store.setPasswordHash(targetId, await hashPassword(input.newPassword), !isSelf);
  await audit(ctx, {
    schoolId: claims.schoolId,
    personId: claims.personId,
    action: "auth.password.set",
    summary: isSelf ? "自分のパスワードを設定" : "管理者がパスワードを再設定",
  });
  return { success: true };
}

/**
 * Completes the forced change (Issue #140): the one call a
 * password-change token authorizes. The token itself is the proof —
 * it is issued only by a password login that presented the
 * administrator-set password — so no current password is asked
 * again. The change clears the mark; from then on the person signs
 * in normally, and the password the administrator knew is dead.
 * A token presented when no change is outstanding (already changed
 * through a session, say) is refused rather than silently becoming
 * a password change without the current password.
 */
export async function completePasswordChange(
  ctx: Ctx,
  personId: string,
  newPassword: string,
): Promise<{ success: true }> {
  const person = await ctx.store.findPersonById(personId);
  if (!person) throw new AuthError(404, "ユーザーが見つかりません");
  if (!person.passwordChangeRequired) {
    throw new AuthError(400, "パスワードの変更は必要ありません");
  }
  await ctx.store.setPasswordHash(personId, await hashPassword(newPassword), false);
  await audit(ctx, {
    personId,
    action: "auth.password.set",
    summary: "変更が必要なパスワードを変更",
  });
  return { success: true };
}
