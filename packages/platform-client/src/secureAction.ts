import { AuthAccessError } from "./errors.js";
import type { AuthContext, Role } from "./types.js";

/**
 * The action-layer guard (DESIGN-AUTH-TENANCY 4.3). Every action goes
 * through secureAction (with a mandatory permission declaration) or
 * publicAction; an action that went through neither does not fit the
 * registry type and is a compile error.
 *
 * A permission is a key of the product's permission table (4.4): the
 * table lives with the product (schedule's is in schedule/), and
 * `Permission<T>` names its keys as a type, so declaring a permission
 * that is not in the table does not compile (Issue #26).
 */
export type PermissionTable = Readonly<Record<string, readonly Role[]>>;

/** A permission name: one of the keys of a permission table. */
export type Permission<T extends PermissionTable> = Extract<keyof T, string>;

export interface SecureAction<Req, Res> {
  readonly kind: "secure";
  readonly permission: string;
  run(auth: AuthContext, request: Req): Promise<Res>;
}

export interface PublicAction<Req, Res> {
  readonly kind: "public";
  run(request: Req): Promise<Res>;
}

export type AnyAction<Req, Res> = SecureAction<Req, Res> | PublicAction<Req, Res>;

export interface SecureActionDefinition<T extends PermissionTable, Req, Res> {
  /** Mandatory, and a key of `permissions`: anything else does not compile. */
  permission: Permission<T>;
  /** The role table (4.4) the permission is checked against. */
  permissions: T;
  handler: (ctx: { auth: AuthContext; request: Req }) => Promise<Res> | Res;
}

/**
 * Wraps a handler so the declared permission is checked against the
 * caller's role before the handler runs (4.3 step 3). Steps 1-2
 * (getting the AuthContext, membership and entitlement) happen in
 * verifyRequest before this is called. The runtime check stays even
 * though the type system keeps undeclared names out: a caller that
 * bypasses the types (plain JS, a cast) is still refused.
 */
export function secureAction<T extends PermissionTable, Req, Res>(
  definition: SecureActionDefinition<T, Req, Res>,
): SecureAction<Req, Res> {
  return {
    kind: "secure",
    permission: definition.permission,
    async run(auth, request) {
      const allowed: readonly Role[] | undefined = definition.permissions[definition.permission];
      if (!allowed || !allowed.includes(auth.role)) {
        throw new AuthAccessError(403, "権限がありません");
      }
      return definition.handler({ auth, request });
    },
  };
}

/** A read open to the public side (4.5); takes no AuthContext at all. */
export function publicAction<Req, Res>(
  handler: (ctx: { request: Req }) => Promise<Res> | Res,
): PublicAction<Req, Res> {
  return {
    kind: "public",
    async run(request) {
      return handler({ request });
    },
  };
}

/**
 * The action registry (4.3): every entry must be a SecureAction or a
 * PublicAction, so registering a bare handler is a type error.
 */
export function defineActions<T extends Record<string, AnyAction<unknown, unknown>>>(
  actions: T,
): T {
  return actions;
}
