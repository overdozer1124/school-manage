import type { AuthContext } from "./types.js";

/**
 * Development adapter (DESIGN-AUTH-TENANCY 5, stage 3): returns a fixed
 * person and role so the products can be built and tested before the
 * platform is wired up. It must never serve a production request, so
 * loading this module throws unless the caller explicitly opted in
 * with PLATFORM_DEV_AUTH=1 — and always throws in production, so
 * forgetting an environment variable fails safe, never open.
 */
if (process.env.NODE_ENV === "production" || process.env.PLATFORM_DEV_AUTH !== "1") {
  throw new Error(
    "@school-manage/platform-client/dev は開発専用です。使う場合は PLATFORM_DEV_AUTH=1 を明示してください（本番では読み込めません）。",
  );
}

export function createDevAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "dev-user",
    schoolId: "dev-school",
    role: "Admin",
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
    ...overrides,
  };
}

export interface DevAuthAdapter {
  /** Same shape as the real client's verifyRequest; ignores the request. */
  verifyRequest(): Promise<AuthContext>;
  /** Switch the fixed school, role or person mid-test. */
  setContext(overrides: Partial<AuthContext>): void;
  /** The context the next verifyRequest will return. */
  current(): AuthContext;
}

export function createDevAuthAdapter(initial: Partial<AuthContext> = {}): DevAuthAdapter {
  let context = createDevAuthContext(initial);
  return {
    async verifyRequest() {
      return context;
    },
    setContext(overrides) {
      context = { ...context, ...overrides };
    },
    current() {
      return context;
    },
  };
}
