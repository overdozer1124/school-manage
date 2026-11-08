import jwt from "jsonwebtoken";
import { AuthAccessError } from "./errors.js";
import type { AuthContext, PlatformContextResponse, Product } from "./types.js";

/** The session cookie the platform sets (Issue #5). */
export const SESSION_COOKIE = "platform_session";

/** The smallest request shape verifyRequest needs. */
export interface RequestLike {
  headers: {
    cookie?: string | string[] | undefined;
  };
}

export interface PlatformClientOptions {
  /** Origin of the platform service, without a trailing slash. */
  platformBaseUrl: string;
  /** The shared JWT secret (the same one the platform signs with). */
  jwtSecret: string;
  /** The product this service is verifying for. */
  product: Product;
  /** How long a successful context lookup is cached. Default 30s. */
  cacheTtlMs?: number;
  /** Cap on cached lookups; the oldest entries go first. Default 1000. */
  maxCacheEntries?: number;
  /** Tests inject a fake; the default is the global fetch. */
  fetchImpl?: typeof fetch;
  /** Tests inject a clock for the cache. */
  now?: () => number;
}

export interface PlatformClient {
  verifyRequest(req: RequestLike): Promise<AuthContext>;
  clearCache(): void;
}

function readSessionCookie(req: RequestLike): string | null {
  const header = req.headers.cookie;
  const text = Array.isArray(header) ? header.join("; ") : header;
  if (!text) return null;
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface VerifiedClaims {
  personId: string;
  schoolId: string;
}

/**
 * Local first pass: the token's signature, expiry and kind. A
 * school-selection token is not a session and never passes. Failures
 * here are 401 without asking the platform anything.
 */
function verifySessionToken(secret: string, token: string): VerifiedClaims {
  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
  } catch {
    throw new AuthAccessError(401, "認証が必要です");
  }
  if (
    typeof decoded.personId !== "string" ||
    typeof decoded.schoolId !== "string" ||
    "purpose" in decoded
  ) {
    throw new AuthAccessError(401, "認証が必要です");
  }
  return { personId: decoded.personId, schoolId: decoded.schoolId };
}

/**
 * Creates the verifier a product service uses for every request
 * (DESIGN-AUTH-TENANCY 4.1/4.3 step 1-2): verify the session JWT
 * locally, then ask the platform whether the membership is approved
 * and in period, the product role exists, and the entitlement is live.
 * Successful answers are cached briefly (30 seconds by default), so a
 * suspension or period end takes effect within that window at the
 * latest; failures are never cached.
 */
export function createPlatformClient(options: PlatformClientOptions): PlatformClient {
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const maxCacheEntries = options.maxCacheEntries ?? 1000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { context: AuthContext; expiresAt: number }>();

  /**
   * Keeps the cache bounded in a long-lived process: expired entries
   * are swept on every store, and past the cap the oldest entries go.
   */
  function pruneCache() {
    const at = now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= at) cache.delete(key);
    }
    while (cache.size >= maxCacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function verifyRequest(req: RequestLike): Promise<AuthContext> {
    const token = readSessionCookie(req);
    if (!token) throw new AuthAccessError(401, "認証が必要です");
    verifySessionToken(options.jwtSecret, token);

    const cached = cache.get(token);
    if (cached && cached.expiresAt > now()) return cached.context;
    if (cached) cache.delete(token);

    const url =
      `${options.platformBaseUrl}/platform/api/v1/auth/context` +
      `?product=${encodeURIComponent(options.product)}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      });
    } catch (cause) {
      throw new Error("共通基盤への問い合わせに失敗しました", { cause });
    }
    if (res.status === 401) throw new AuthAccessError(401, "認証が必要です");
    if (res.status === 403) throw new AuthAccessError(403, "権限がありません");
    if (res.status !== 200) {
      throw new Error(`共通基盤への問い合わせが失敗しました (HTTP ${res.status})`);
    }

    const body = (await res.json()) as PlatformContextResponse;
    if (
      typeof body?.userId !== "string" ||
      typeof body?.schoolId !== "string" ||
      body.product !== options.product ||
      (body.role !== "Admin" && body.role !== "Editor" && body.role !== "Viewer")
    ) {
      throw new Error("共通基盤の応答が正しくありません");
    }
    const context: AuthContext = {
      userId: body.userId,
      schoolId: body.schoolId,
      role: body.role,
      isSuperAdmin: body.isSuperAdmin === true,
      personId: null,
      teacherId: typeof body.teacherId === "string" ? body.teacherId : null,
    };
    pruneCache();
    cache.set(token, { context, expiresAt: now() + cacheTtlMs });
    return context;
  }

  return {
    verifyRequest,
    clearCache() {
      cache.clear();
    },
  };
}
