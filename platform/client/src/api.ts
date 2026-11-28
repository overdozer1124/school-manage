/**
 * The login screens' API口 (Issue #129): the only place the client
 * talks to the platform server. The endpoints are the login API of
 * Issue #5 / #128 under /platform/api/v1/auth, on the same domain
 * the page itself was delivered from (DESIGN-INTEGRATION 8-3-1), so
 * the session cookie rides along untouched.
 *
 * A login answer has three shapes, told apart by the body:
 * - { user, school } — a session was issued (cookie set).
 * - { schoolSelectionRequired: true, user, schools } — the person
 *   belongs to several schools and chooses one (selectSchool).
 * - { passwordChangeRequired: true, user } — Issue #140: an
 *   administrator or operator set this person's password, and it
 *   may not be used until the person changes it. No session and no
 *   school selection are offered; the server sets a restricted
 *   cookie (platform_change, scoped to the auth API, ten minutes)
 *   that authorizes only the change, and the only way forward is
 *   setPassword with { newPassword } — no currentPassword, the
 *   cookie itself is the proof. The server clears the cookie on
 *   success, and the person logs in again with the new password.
 * Failures are { error } with the status: 401 is a credential
 * failure (the server words a wrong password and an unknown email
 * identically), 403 is the unconfirmed-membership notice (invited,
 * suspended or out of period — the server folds them into one
 * message), anything else is shown as it came.
 */

export interface UserSummary {
  id: string;
  name: string;
  email: string;
}

export interface SchoolSummary {
  schoolId: string;
  name: string;
  slug: string | null;
}

export type LoginOutcome =
  | { kind: "session"; user: UserSummary; school: SchoolSummary }
  | { kind: "selection"; user: UserSummary; schools: SchoolSummary[] }
  | { kind: "password-change-required"; user: UserSummary };

export interface MeResult {
  user: UserSummary;
  school: SchoolSummary;
  teacherId: string | null;
  hasPassword: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const AUTH_BASE = "/platform/api/v1/auth";

interface RawLoginBody {
  user?: UserSummary;
  school?: SchoolSummary;
  schools?: SchoolSummary[];
  schoolSelectionRequired?: boolean;
  passwordChangeRequired?: boolean;
  error?: string;
}

function toOutcome(body: RawLoginBody): LoginOutcome {
  if (body.passwordChangeRequired && body.user) {
    return { kind: "password-change-required", user: body.user };
  }
  if (body.schoolSelectionRequired && body.user && body.schools) {
    return { kind: "selection", user: body.user, schools: body.schools };
  }
  if (body.user && body.school) {
    return { kind: "session", user: body.user, school: body.school };
  }
  throw new ApiError(500, "サーバーからの応答が正しくありません");
}

export interface LoginApi {
  login(email: string, password: string): Promise<LoginOutcome>;
  googleAuthUrl(redirectUri: string): Promise<string>;
  googleCallback(code: string, state: string, redirectUri: string): Promise<LoginOutcome>;
  selectSchool(schoolId: string): Promise<LoginOutcome>;
  setPassword(newPassword: string): Promise<void>;
  /** The current session's identity, or null when there is none. */
  me(): Promise<MeResult | null>;
  logout(): Promise<void>;
}

export function createLoginApi(fetchImpl: typeof fetch = fetch): LoginApi {
  async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetchImpl(`${AUTH_BASE}${path}`, {
      ...init,
      // The session, selection and password-change cookies are
      // the credentials; they must ride along on every call.
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      throw new ApiError(res.status, body.error ?? "サーバーエラーが発生しました");
    }
    return { status: res.status, body };
  }

  async function loginCall(path: string, payload: unknown): Promise<LoginOutcome> {
    const { body } = await call<RawLoginBody>(path, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return toOutcome(body);
  }

  return {
    login: (email, password) => loginCall("/login", { email, password }),
    async googleAuthUrl(redirectUri) {
      const { body } = await call<{ authUrl?: string }>("/google/url", {
        method: "POST",
        body: JSON.stringify({ redirectUri }),
      });
      if (!body.authUrl) throw new ApiError(500, "サーバーからの応答が正しくありません");
      return body.authUrl;
    },
    googleCallback: (code, state, redirectUri) =>
      loginCall("/google/callback", { code, state, redirectUri }),
    selectSchool: (schoolId) => loginCall("/select-school", { schoolId }),
    async setPassword(newPassword) {
      await call("/set-password", { method: "POST", body: JSON.stringify({ newPassword }) });
    },
    async me() {
      try {
        const { body } = await call<MeResult>("/me");
        return body;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    async logout() {
      await call("/logout", { method: "POST", body: JSON.stringify({}) });
    },
  };
}

/**
 * The page a login returns to. Only a path on this domain is
 * accepted: an absolute URL, a protocol-relative //host path, or a
 * backslash trick would send the freshly signed-in person to
 * another site (an open redirect), so anything of the sort is
 * ignored and the caller falls back to the school's own page. The
 * login page itself is never a destination — returning there after
 * a login would loop.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) {
    return null;
  }
  return value;
}

/** Where a completed login lands: the return path when one was
 *  given (and accepted), else the chosen school's schedule page. */
export function afterLoginPath(returnPath: string | null, school: SchoolSummary): string {
  if (returnPath) return returnPath;
  return school.slug ? `/${school.slug}/schedule/` : "/";
}
