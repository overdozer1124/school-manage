import { randomBytes } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthStore } from "../db/authStore.js";
import type { AuthConfig } from "./config.js";
import { AuthError } from "./errors.js";
import { createGoogleAuthClient, type GoogleAuthClient } from "./google.js";
import { createRateLimiter } from "./rateLimit.js";
import {
  buildGoogleAuthUrl,
  getAuthContext,
  getMe,
  loginWithGoogle,
  loginWithPassword,
  selectSchool,
  type LoginResult,
} from "./service.js";
import {
  expiresInToSeconds,
  isSelectionClaims,
  verifyAuthToken,
  type TokenClaims,
} from "./tokens.js";

/**
 * HTTP surface for the login flow: /platform/api/v1/auth/* (versioned
 * HTTP + JSON, DESIGN-INTEGRATION 7-3). The session travels in a cookie
 * shared by the three services on the same domain (8-3-1):
 * HttpOnly; Secure; SameSite=Lax; Path=/ (DESIGN-AUTH-TENANCY 4.8).
 */
export const SESSION_COOKIE = "platform_session";

/**
 * The pre-selection token gets its own cookie, scoped to the auth API:
 * other services read only platform_session, so a token that has no
 * school yet can never be mistaken for a session there.
 */
export const SELECT_COOKIE = "platform_select";
const SELECT_COOKIE_PATH = "/platform/api/v1/auth";

/**
 * The Google login browser binding (Issue #16): /google/url sets a
 * random value here and embeds the same value in the signed state;
 * the callback compares the two and clears the cookie. Same path and
 * flags as the selection cookie; ten minutes matches the state's age
 * limit.
 */
export const OAUTH_COOKIE = "platform_oauth";

function oauthCookie(binding: string): string {
  return `${OAUTH_COOKIE}=${encodeURIComponent(binding)}; HttpOnly; Secure; SameSite=Lax; Path=${SELECT_COOKIE_PATH}; Max-Age=${10 * 60}`;
}

function clearedOAuthCookie(): string {
  return `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${SELECT_COOKIE_PATH}; Max-Age=0`;
}

export interface AuthRouterDeps {
  store: AuthStore;
  config: AuthConfig;
  /** Tests inject a fake; the default talks to Google for real. */
  googleClient?: GoogleAuthClient;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearedCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function selectionCookie(token: string): string {
  return `${SELECT_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=${SELECT_COOKIE_PATH}; Max-Age=${10 * 60}`;
}

function clearedSelectionCookie(): string {
  return `${SELECT_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${SELECT_COOKIE_PATH}; Max-Age=0`;
}

function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** The session cookie only: tokens are never read from headers or bodies. */
export function readSessionToken(req: Request): string | null {
  return readCookie(req, SESSION_COOKIE);
}

/**
 * For choosing a school: the selection cookie if present, else the
 * session cookie (a signed-in person switching schools).
 */
function readChoiceToken(req: Request): string | null {
  return readCookie(req, SELECT_COOKIE) ?? readCookie(req, SESSION_COOKIE);
}

function requireClaims(deps: AuthRouterDeps, token: string | null): TokenClaims {
  const claims = token ? verifyAuthToken(deps.config, token) : null;
  if (!claims) throw new AuthError(401, "認証が必要です");
  return claims;
}

function sendLoginResult(
  deps: AuthRouterDeps,
  res: Response,
  result: LoginResult,
  extraCookies: string[] = [],
): void {
  if (result.kind === "session") {
    // The cookie's Max-Age follows JWT_EXPIRES_IN so the two cannot drift.
    // Issuing a session also clears the selection cookie: /select-school
    // reads platform_select first, so a leftover selection token from a
    // previous user of the same browser could otherwise be exchanged
    // for that person's session.
    res.setHeader("Set-Cookie", [
      sessionCookie(result.token, expiresInToSeconds(deps.config.jwtExpiresIn)),
      clearedSelectionCookie(),
      ...extraCookies,
    ]);
    // The token travels only in the HttpOnly cookie, never in the body:
    // a body token would be readable by any script on the page.
    res.json({ user: result.user, school: result.school });
    return;
  }
  res.setHeader("Set-Cookie", [selectionCookie(result.selectionToken), ...extraCookies]);
  res.json({
    schoolSelectionRequired: true,
    user: result.user,
    schools: result.schools,
  });
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "サーバーエラーが発生しました" });
}

function parseBody<T>(schema: z.ZodType<T>, req: Request): T {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new AuthError(400, "入力が正しくありません");
  }
  return parsed.data;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  schoolId: z.string().min(1).optional(),
});

const selectSchoolSchema = z.object({
  schoolId: z.string().min(1),
});

const googleUrlSchema = z.object({
  redirectUri: z.string().url(),
  schoolId: z.string().min(1).optional(),
  schoolSlug: z.string().min(1).optional(),
});

const googleCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  redirectUri: z.string().url(),
  schoolId: z.string().min(1).optional(),
});

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const ctx = { store: deps.store, config: deps.config };
  // Password login failures (Issue #16), counted per email address
  // and per source address with separate allowances — the source
  // allowance is far larger because a school's teachers share one
  // outward address. One pair of limiters per router, i.e. per process.
  const windowMs = deps.config.loginRateLimitWindowSeconds * 1000;
  const emailLimiter = createRateLimiter({
    maxFailures: deps.config.loginRateLimitMaxFailures,
    windowMs,
  });
  const ipLimiter = createRateLimiter({
    maxFailures: deps.config.loginRateLimitIpMaxFailures,
    windowMs,
  });

  // CSRF guard for state-changing calls (4.8): when a browser sends an
  // Origin header it must name this host. Requests without an Origin
  // (server-to-server, tests) are not browsers and pass.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin) {
        let originHost: string | null = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (originHost === null || originHost !== req.headers.host) {
          res.status(403).json({ error: "Origin が一致しません" });
          return;
        }
      }
    }
    next();
  });

  router.post("/login", async (req, res) => {
    // Declared outside the try so the catch can record the failure
    // against the same keys; a body that fails to parse leaves them
    // undefined and records nothing.
    let emailKey: string | undefined;
    let ipKey: string | undefined;
    try {
      const input = parseBody(loginSchema, req);
      emailKey = `email:${input.email.toLowerCase()}`;
      ipKey = `ip:${req.ip ?? "unknown"}`;
      if (emailLimiter.isBlocked(emailKey) || ipLimiter.isBlocked(ipKey)) {
        // The refusal itself is audited (best effort, like the
        // service's own audit entries); no credential is recorded.
        try {
          await deps.store.appendAudit({
            schoolId: null,
            personId: null,
            action: "auth.login.rate_limited",
            target: "auth",
            summary: "ログイン試行の回数制限で拒否",
          });
        } catch {
          /* best effort */
        }
        throw new AuthError(
          429,
          "ログインの試行回数が上限を超えました。しばらく待ってから再度お試しください。Google ログインも利用できます。",
        );
      }
      const result = await loginWithPassword(ctx, {
        email: input.email,
        password: input.password,
        ...(input.schoolId !== undefined ? { schoolId: input.schoolId } : {}),
      });
      // A success clears the email key's slate: a person who mistyped
      // a few times and then got in is not close to the limit the next
      // time they log in. The source key keeps its failures.
      emailLimiter.reset(emailKey);
      sendLoginResult(deps, res, result);
    } catch (error) {
      // Only credential failures count (401). A 403 means the
      // credentials were right but the membership was not usable —
      // retrying that is not password guessing.
      if (error instanceof AuthError && error.status === 401) {
        if (emailKey) emailLimiter.recordFailure(emailKey);
        if (ipKey) ipLimiter.recordFailure(ipKey);
      }
      handleError(res, error);
    }
  });

  router.post("/select-school", async (req, res) => {
    try {
      const claims = requireClaims(deps, readChoiceToken(req));
      const input = parseBody(selectSchoolSchema, req);
      // Both a selection token and a live session may choose: the first
      // completes the login, the second is switching schools.
      const result = await selectSchool(ctx, claims.personId, input.schoolId);
      sendLoginResult(deps, res, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/logout", (req, res) => {
    // Stateless JWTs cannot be revoked server-side; logging out clears
    // the shared cookie, which is what the browsers of the three
    // services use. The token itself expires on its own schedule.
    void req;
    res.setHeader("Set-Cookie", [clearedCookie(), clearedSelectionCookie()]);
    res.json({ success: true });
  });

  router.get("/me", async (req, res) => {
    try {
      const claims = requireClaims(deps, readSessionToken(req));
      if (isSelectionClaims(claims)) throw new AuthError(401, "認証が必要です");
      const me = await getMe(ctx, claims);
      res.json(me);
    } catch (error) {
      handleError(res, error);
    }
  });

  // The context lookup the product services' verifyRequest calls
  // (Issue #6): the session cookie in, the AuthContext out, with
  // 401 (not logged in) and 403 (not entitled) kept apart.
  router.get("/context", async (req, res) => {
    try {
      const claims = requireClaims(deps, readSessionToken(req));
      if (isSelectionClaims(claims)) throw new AuthError(401, "認証が必要です");
      const product = typeof req.query.product === "string" ? req.query.product : "";
      const context = await getAuthContext(ctx, claims, product);
      res.json(context);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/google/url", async (req, res) => {
    try {
      const input = parseBody(googleUrlSchema, req);
      let schoolId = input.schoolId;
      if (input.schoolSlug) {
        const school = await deps.store.findSchoolBySlug(input.schoolSlug);
        if (!school) throw new AuthError(400, "指定された学校が見つかりません");
        if (schoolId && schoolId !== school.schoolId) {
          throw new AuthError(400, "学校の指定が一致しません");
        }
        schoolId = school.schoolId;
      }
      // Bind this login attempt to this browser (Issue #16): the same
      // random value goes into the signed state and into a short-lived
      // cookie only this browser holds.
      const binding = randomBytes(16).toString("hex");
      const result = buildGoogleAuthUrl(ctx, {
        redirectUri: input.redirectUri,
        ...(schoolId !== undefined ? { schoolId } : {}),
        binding,
      });
      res.setHeader("Set-Cookie", oauthCookie(binding));
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/google/callback", async (req, res) => {
    try {
      const input = parseBody(googleCallbackSchema, req);
      const google = deps.googleClient ?? createGoogleAuthClient(deps.config);
      const result = await loginWithGoogle(
        { ...ctx, google },
        {
          code: input.code,
          state: input.state,
          redirectUri: input.redirectUri,
          ...(input.schoolId !== undefined ? { schoolId: input.schoolId } : {}),
        },
        readCookie(req, OAUTH_COOKIE),
      );
      // The binding is single-use: its clearing cookie rides along
      // with the login result's own cookies, because headers cannot
      // be added after the response is sent.
      sendLoginResult(deps, res, result, [clearedOAuthCookie()]);
    } catch (error) {
      res.setHeader("Set-Cookie", clearedOAuthCookie());
      handleError(res, error);
    }
  });

  return router;
}
