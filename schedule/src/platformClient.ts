/**
 * The one place the schedule server calls the platform API
 * (DESIGN-INTEGRATION 10, implementation 1). The schedule screens talk
 * only to this server; this server in turn calls the platform with
 * the user's session cookie forwarded as-is, so the platform itself
 * performs the permission checks (the either-product Editor rule and
 * the absence privacy rules live there, not here).
 *
 * The client forwards the cookie and returns the platform's answer
 * untouched — status and body — because a relayed verdict (401, 403,
 * 409, ...) is the platform's to give and the caller's to receive
 * as-is (Issue #29).
 */
export interface PlatformApiResult {
  status: number;
  body: unknown;
}

export type PlatformApiMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface PlatformApiClient {
  /**
   * Calls a platform API path (starting with "/") with the user's
   * cookie header forwarded untouched. `body`, when given, is sent
   * as JSON (the platform's DELETE endpoints take their revision in
   * the body, so DELETE carries one too).
   */
  requestJson(
    method: PlatformApiMethod,
    path: string,
    cookie: string,
    body?: unknown,
  ): Promise<PlatformApiResult>;
  /** GETs a platform API path; requestJson with method "GET". */
  getJson(path: string, cookie: string): Promise<PlatformApiResult>;
}

/**
 * A platform verdict relayed to the caller: the platform answered
 * with a non-success status, and its status and body travel with the
 * error so the caller (and, later, the screen) sees exactly what the
 * platform said — 401, 403 and 409 keep their meaning end to end.
 */
export class PlatformRelayError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(result: PlatformApiResult) {
    super(`platform answered ${result.status}`);
    this.name = "PlatformRelayError";
    this.status = result.status;
    this.body = result.body;
  }
}

/** Throws a PlatformRelayError unless the platform answered 2xx. */
export function unwrapPlatformResult(result: PlatformApiResult): unknown {
  if (result.status < 200 || result.status >= 300) {
    throw new PlatformRelayError(result);
  }
  return result.body;
}

export function createPlatformApiClient(options: {
  /** Origin of the platform service; a trailing slash is trimmed. */
  baseUrl: string;
  /** Tests inject a fake; the default is the global fetch. */
  fetchImpl?: typeof fetch;
}): PlatformApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  async function requestJson(
    method: PlatformApiMethod,
    path: string,
    cookie: string,
    body?: unknown,
  ): Promise<PlatformApiResult> {
    const init: RequestInit = { method, headers: { cookie } };
    if (body !== undefined) {
      init.headers = { cookie, "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${baseUrl}${path}`, init);
    const parsed: unknown = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  }

  return {
    requestJson,
    getJson: (path, cookie) => requestJson("GET", path, cookie),
  };
}
