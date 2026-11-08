import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AuthStore } from "../db/authStore.js";
import type { AuthConfig } from "./config.js";
import { AuthError } from "./errors.js";
import { createGoogleAuthClient, type GoogleAuthClient } from "./google.js";
import {
  buildGoogleAuthUrl,
  getMe,
  loginWithGoogle,
  loginWithPassword,
  selectSchool,
  type LoginResult,
} from "./service.js";
import { isSelectionClaims, verifyAuthToken, type TokenClaims } from "./tokens.js";

/**
 * HTTP surface for the login flow: /platform/api/v1/auth/* (versioned
 * HTTP + JSON, DESIGN-INTEGRATION 7-3). The session travels in a cookie
 * shared by the three services on the same domain (8-3-1):
 * HttpOnly; Secure; SameSite=Lax; Path=/ (DESIGN-AUTH-TENANCY 4.8).
 */
export const SESSION_COOKIE = "platform_session";

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

function readToken(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
  }
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return null;
}

function requireClaims(deps: AuthRouterDeps, req: Request): TokenClaims {
  const token = readToken(req);
  const claims = token ? verifyAuthToken(deps.config, token) : null;
  if (!claims) throw new AuthError(401, "認証が必要です");
  return claims;
}

function sendLoginResult(res: Response, result: LoginResult): void {
  if (result.kind === "session") {
    res.setHeader("Set-Cookie", sessionCookie(result.token, 7 * 24 * 60 * 60));
    res.json({ token: result.token, user: result.user, school: result.school });
    return;
  }
  res.setHeader("Set-Cookie", sessionCookie(result.selectionToken, 10 * 60));
  res.json({
    schoolSelectionRequired: true,
    selectionToken: result.selectionToken,
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
    try {
      const input = parseBody(loginSchema, req);
      const result = await loginWithPassword(ctx, {
        email: input.email,
        password: input.password,
        ...(input.schoolId !== undefined ? { schoolId: input.schoolId } : {}),
      });
      sendLoginResult(res, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/select-school", async (req, res) => {
    try {
      const claims = requireClaims(deps, req);
      const input = parseBody(selectSchoolSchema, req);
      // Both a selection token and a live session may choose: the first
      // completes the login, the second is switching schools.
      const result = await selectSchool(ctx, claims.personId, input.schoolId);
      sendLoginResult(res, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/logout", (req, res) => {
    // Stateless JWTs cannot be revoked server-side; logging out clears
    // the shared cookie, which is what the browsers of the three
    // services use. The token itself expires on its own schedule.
    void req;
    res.setHeader("Set-Cookie", clearedCookie());
    res.json({ success: true });
  });

  router.get("/me", async (req, res) => {
    try {
      const claims = requireClaims(deps, req);
      if (isSelectionClaims(claims)) throw new AuthError(401, "認証が必要です");
      const me = await getMe(ctx, claims);
      res.json(me);
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
      const result = buildGoogleAuthUrl(ctx, {
        redirectUri: input.redirectUri,
        ...(schoolId !== undefined ? { schoolId } : {}),
      });
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
      );
      sendLoginResult(res, result);
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
