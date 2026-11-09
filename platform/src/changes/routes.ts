import { Router, type Request, type Response } from "express";
import type { AuthConfig } from "../auth/config.js";
import { AuthError } from "../auth/errors.js";
import { isMembershipCandidate, todayString } from "../auth/membership.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import { isSelectionClaims, verifyAuthToken, type SessionClaims } from "../auth/tokens.js";
import type { AuthStore } from "../db/authStore.js";
import type { ChangeStore } from "../db/changes.js";

/**
 * The refetch endpoint for the change outbox (Issue #21,
 * DESIGN-INTEGRATION 7.1): GET /platform/api/v1/changes?after=&limit=.
 * A signed-in member of a school reads that school's changes only, in
 * seq order. Server-to-server calls from the products get their own
 * credential in the webhook issue; this endpoint takes the user
 * session cookie only, like the rest of the platform API.
 */
export interface ChangesRouterDeps {
  config: AuthConfig;
  authStore: AuthStore;
  changeStore: ChangeStore;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The session cookie only: tokens are never read from headers or bodies. */
function readSessionToken(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function requireSession(deps: ChangesRouterDeps, req: Request): SessionClaims {
  const token = readSessionToken(req);
  const claims = token ? verifyAuthToken(deps.config, token) : null;
  if (!claims || isSelectionClaims(claims)) throw new AuthError(401, "認証が必要です");
  return claims;
}

function parseAfter(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new AuthError(400, "入力が正しくありません");
  }
  return Number(value);
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new AuthError(400, "入力が正しくありません");
  }
  const parsed = Number(value);
  if (parsed < 1) throw new AuthError(400, "入力が正しくありません");
  return Math.min(parsed, MAX_LIMIT);
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "サーバーエラーが発生しました" });
}

export function createChangesRouter(deps: ChangesRouterDeps): Router {
  const router = Router();

  router.get("/changes", async (req, res) => {
    try {
      const claims = requireSession(deps, req);
      // The session names the school; the membership must still be in
      // force (approved and inside its enrolment period), as at login.
      const memberships = await deps.authStore.listMemberships(claims.personId);
      const today = todayString();
      const isMember = memberships.some(
        (m) => m.schoolId === claims.schoolId && isMembershipCandidate(m, today),
      );
      if (!isMember) throw new AuthError(403, "権限がありません");
      const after = parseAfter(req.query.after);
      const limit = parseLimit(req.query.limit);
      const changes = await deps.changeStore.listChanges(claims.schoolId, after, limit);
      res.json({ changes });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
