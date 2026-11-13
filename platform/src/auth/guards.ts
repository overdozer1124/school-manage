import type { Request } from "express";
import type { AuthStore } from "../db/authStore.js";
import type { Membership, Product } from "../db/schema.js";
import type { AuthConfig } from "./config.js";
import { AuthError } from "./errors.js";
import { isMembershipCandidate, todayString } from "./membership.js";
import { readSessionToken } from "./routes.js";
import { isSelectionClaims, verifyAuthToken, type SessionClaims } from "./tokens.js";

/**
 * The session / membership / writer guards shared by the platform
 * API routers (masters, events, calendar days and holidays, and the
 * changes refetch endpoint). They used to be copied into each
 * router; the copies were identical, so they live here now (PR #60
 * review recommendation) and the permission judgments cannot drift
 * apart between routers.
 *
 * Reads need a current membership of the session's school; writes
 * need Editor or more in either product （連携5). A missing or
 * pre-selection session is 401, a session without a current
 * membership (or without the writer role) is 403.
 */

/** The slice of the router deps the guards read. Every platform API
 *  router's deps carry at least these two fields. */
export interface GuardDeps {
  config: AuthConfig;
  authStore: AuthStore;
}

export interface AuthedMember {
  claims: SessionClaims;
  membership: Membership;
}

export function requireSession(deps: GuardDeps, req: Request): SessionClaims {
  const token = readSessionToken(req);
  const claims = token ? verifyAuthToken(deps.config, token) : null;
  if (!claims || isSelectionClaims(claims)) throw new AuthError(401, "認証が必要です");
  return claims;
}

export async function requireMember(deps: GuardDeps, req: Request): Promise<AuthedMember> {
  const claims = requireSession(deps, req);
  const memberships = await deps.authStore.listMemberships(claims.personId);
  const today = todayString();
  const membership = memberships.find(
    (m) => m.schoolId === claims.schoolId && isMembershipCandidate(m, today),
  );
  if (!membership) throw new AuthError(403, "権限がありません");
  return { claims, membership };
}

/** Editor or more in either product may write （連携5). */
export async function requireWriter(deps: GuardDeps, req: Request): Promise<AuthedMember> {
  const authed = await requireMember(deps, req);
  const products: Product[] = ["schedule", "timetable"];
  for (const product of products) {
    const role = await deps.authStore.findProductRole(authed.membership.id, product);
    if (role && (role.role === "Admin" || role.role === "Editor")) return authed;
  }
  throw new AuthError(403, "権限がありません");
}
