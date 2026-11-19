import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { AuthConfig } from "../auth/config.js";
import { AuthError } from "../auth/errors.js";
import { requireSession } from "../auth/guards.js";
import { isMembershipCandidate, todayString } from "../auth/membership.js";
import type { AuthStore } from "../db/authStore.js";
import type { ChangeStore } from "../db/changes.js";
import type { Product } from "../db/schema.js";

/**
 * The refetch endpoint for the change outbox (Issue #21,
 * DESIGN-INTEGRATION 7.1): GET /platform/api/v1/changes?after=&limit=.
 * A signed-in member of a school reads that school's changes only, in
 * seq order.
 *
 * Since Issue #106 the products' servers read it too, with a
 * per-product service credential (a bearer token from the
 * environment, CHANGES_<PRODUCT>_SERVICE_TOKEN; its value is never
 * in code). A request carrying an Authorization header is judged by
 * that credential alone — a missing or wrong one is a 401, never a
 * fall-through to the session — and reads the changes of every
 * school entitled to that product, because a receiver keeps one
 * watermark across its schools. A request without the header takes
 * the session cookie exactly as before.
 */
export interface ChangesRouterDeps {
  config: AuthConfig;
  authStore: AuthStore;
  changeStore: ChangeStore;
  /**
   * The per-product service credentials for server-to-server reads.
   * A product with no token configured cannot be read for: the
   * check fails closed, as the public-read path's does (Issue #82).
   */
  serviceTokens?: Partial<Record<Product, string>>;
}

export function loadChangesServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): Pick<ChangesRouterDeps, "serviceTokens"> {
  const serviceTokens: Partial<Record<Product, string>> = {};
  const schedule = env.CHANGES_SCHEDULE_SERVICE_TOKEN || undefined;
  if (schedule) serviceTokens.schedule = schedule;
  const timetable = env.CHANGES_TIMETABLE_SERVICE_TOKEN || undefined;
  if (timetable) serviceTokens.timetable = timetable;
  return { serviceTokens };
}

function credentialMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The product a request's service credential speaks for, or
 * undefined. Returns undefined both when no Authorization header is
 * present (the caller then takes the session path) and — as null —
 * when a header is present but matches no configured token, so the
 * two cases stay distinguishable.
 */
function serviceProductFor(deps: ChangesRouterDeps, req: Request): Product | null | undefined {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const presented =
    typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return null;
  for (const [product, token] of Object.entries(deps.serviceTokens ?? {})) {
    if (token && credentialMatches(presented, token)) return product as Product;
  }
  return null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

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
      const serviceProduct = serviceProductFor(deps, req);
      if (serviceProduct !== undefined) {
        if (serviceProduct === null) throw new AuthError(401, "認証が必要です");
        const after = parseAfter(req.query.after);
        const limit = parseLimit(req.query.limit);
        const changes = await deps.changeStore.listChangesForProduct(
          serviceProduct,
          after,
          limit,
          todayString(),
        );
        res.json({ changes });
        return;
      }
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
