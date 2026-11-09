/**
 * The one place the schedule server calls the platform API
 * (DESIGN-INTEGRATION 10, implementation 1). The schedule screens talk
 * only to this server; this server in turn calls the platform with
 * the user's session cookie forwarded as-is, so the platform itself
 * performs the permission checks (the either-product Editor rule and
 * the absence privacy rules live there, not here).
 *
 * This issue lays the foundation only: the client forwards the
 * cookie and parses the answer; the calendar and master calls arrive
 * with their own issues.
 */
export interface PlatformApiResult {
  status: number;
  body: unknown;
}

export interface PlatformApiClient {
  /**
   * GETs a platform API path (starting with "/") with the user's
   * cookie header forwarded untouched.
   */
  getJson(path: string, cookie: string): Promise<PlatformApiResult>;
}

export function createPlatformApiClient(options: {
  /** Origin of the platform service; a trailing slash is trimmed. */
  baseUrl: string;
  /** Tests inject a fake; the default is the global fetch. */
  fetchImpl?: typeof fetch;
}): PlatformApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return {
    async getJson(path, cookie) {
      const res = await fetchImpl(`${baseUrl}${path}`, { headers: { cookie } });
      const body: unknown = await res.json().catch(() => null);
      return { status: res.status, body };
    },
  };
}
