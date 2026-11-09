import {
  createPlatformClient,
  type AuthContext,
  type RequestLike,
} from "@school-manage/platform-client";

/**
 * How the schedule server learns who is calling (DESIGN-AUTH-TENANCY
 * 4.1 / 4.3 steps 1-2). Schedule never verifies the session token
 * itself: the platform-client asks the platform on every request,
 * because the products never hold the JWT secret (the decision on
 * Issue #6). The platform answers 401 (not signed in) or 403 (no
 * valid membership / entitlement) or the AuthContext.
 *
 * In development the platform-client's dev adapter can stand in, but
 * only when PLATFORM_DEV_AUTH=1 was set explicitly: the adapter
 * module itself refuses to load otherwise, and always in production.
 */
export interface ScheduleAuth {
  verifyRequest(req: RequestLike): Promise<AuthContext>;
}

export interface ScheduleAuthOptions {
  /** Origin of the platform service, without a trailing slash. */
  platformBaseUrl: string;
  /** Tests inject a fake; the default is the global fetch. */
  fetchImpl?: typeof fetch;
  /** Use the development adapter. Defaults to PLATFORM_DEV_AUTH === "1". */
  devAuth?: boolean;
}

export async function createScheduleAuth(options: ScheduleAuthOptions): Promise<ScheduleAuth> {
  const devAuth = options.devAuth ?? process.env.PLATFORM_DEV_AUTH === "1";
  if (devAuth) {
    const dev = await import("@school-manage/platform-client/dev");
    const adapter = dev.createDevAuthAdapter();
    return { verifyRequest: () => adapter.verifyRequest() };
  }
  const client = createPlatformClient({
    platformBaseUrl: options.platformBaseUrl,
    product: "schedule",
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { verifyRequest: (req) => client.verifyRequest(req) };
}
