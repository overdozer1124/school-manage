import type { AuthStore } from "../db/authStore.js";
import type { Membership, Person, School } from "../db/schema.js";
import type { AuthConfig } from "./config.js";
import { AuthError } from "./errors.js";
import type { GoogleAuthClient } from "./google.js";
import {
  candidateMemberships,
  todayString,
  UNCONFIRMED_SCHOOL_MEMBERSHIP_MESSAGE,
} from "./membership.js";
import { createLoginOAuthState, parseLoginOAuthState } from "./oauthState.js";
import {
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
  input: { redirectUri: string; schoolId?: string },
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
  const state = createLoginOAuthState(ctx.config.jwtSecret, schoolId);
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
): Promise<LoginResult> {
  // The signed state is verified before anything else, so a tampered or
  // swapped school id is refused early (source order, R6).
  const stateParts = parseLoginOAuthState(ctx.config.jwtSecret, input.state);
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
  if (!profile.email) {
    throw new AuthError(400, "メールアドレスが取得できませんでした");
  }
  if (!profile.googleId) {
    throw new AuthError(400, "Google IDが取得できませんでした");
  }

  // Registered and confirmed only (source: resolveConfirmedSchoolUser-
  // ForGoogleLogin). Look up by email first, then by Google id.
  let person = await ctx.store.findPersonByEmail(profile.email);
  if (!person && profile.googleId) {
    person = await ctx.store.findPersonByGoogleId(profile.googleId);
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
