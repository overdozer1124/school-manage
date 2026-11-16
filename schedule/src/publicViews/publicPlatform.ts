import type { Audience } from "@school-manage/calendar-types";
import {
  unwrapPlatformResult,
  type PlatformApiClient,
  type PlatformApiResult,
} from "../platformClient.js";

/**
 * The schedule server's client for the platform's public-read path
 * (Issue #82): the session-less reads behind the public viewing
 * pages. There is no user on this path, so there is no cookie to
 * forward — the client presents the service credential
 * (PUBLIC_READ_SERVICE_TOKEN, a bearer token from the environment;
 * its value is never in code) and names the school and the audience
 * on every request, and the platform applies the audience filter
 * itself (DESIGN-INTEGRATION 6).
 *
 * The dedicated reads (school, holidays, grades) are the public
 * bootstrap's. The range computation (computeRange) speaks the
 * member paths through a PlatformApiClient, so asPlatformClient
 * adapts: bound to one token's school and audience, it translates
 * the three calendar reads computeRange makes for a non-staff view
 * onto the public-read path, and refuses everything else — a write,
 * or a read this path does not serve (absences above all), is
 * answered as an error rather than silently rerouted.
 */
const PUBLIC_READ_BASE = "/platform/api/v1/public-read";
const MEMBER_DAYS_PATH = "/platform/api/v1/calendar/days";
const MEMBER_HOLIDAYS_PATH = "/platform/api/v1/calendar/holidays";
const MEMBER_EVENTS_PATH = "/platform/api/v1/calendar/events";

type Record_ = Record<string, unknown>;

/** The `items` of a platform list answer, as opaque records (the
 *  same reading as the range actions). */
function itemsOf(body: unknown): Record_[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is Record_ => typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

export interface PublicPlatformClient {
  /** The school's public face: its name (and slug), from the
   *  public-read path — never from /auth/me, which needs a session
   *  this path does not have (Issue #82). */
  getSchool(schoolId: string, audience: Audience): Promise<Record_>;
  /** The school's holidays in [from, to], public shape. */
  getHolidays(
    schoolId: string,
    audience: Audience,
    range: { from: string; to: string },
  ): Promise<Record_[]>;
  /** The school's grades (the axis the per-grade values name). */
  getGrades(schoolId: string, audience: Audience): Promise<Record_[]>;
  /**
   * A PlatformApiClient bound to one school and audience, reading
   * through the public-read path, for computeRange. The cookie the
   * range computation passes is ignored: there is no user.
   */
  asPlatformClient(schoolId: string, audience: Audience): PlatformApiClient;
}

export function createPublicPlatformClient(options: {
  /** Origin of the platform service; a trailing slash is trimmed. */
  baseUrl: string;
  /** The service credential presented to the platform, from
   *  PUBLIC_READ_SERVICE_TOKEN. When unset, no credential is sent
   *  and the platform refuses (401): the path fails closed. This
   *  client reports that refusal as a 503 (see request below). */
  serviceToken?: string | undefined;
  /** Tests inject a fake; the default is the global fetch. */
  fetchImpl?: typeof fetch;
}): PublicPlatformClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  async function request(path: string): Promise<PlatformApiResult> {
    const headers: Record<string, string> = {};
    if (options.serviceToken) {
      headers.authorization = `Bearer ${options.serviceToken}`;
    }
    const res = await fetchImpl(`${baseUrl}${path}`, { method: "GET", headers });
    const parsed: unknown = await res.json().catch(() => null);
    if (res.status === 401) {
      // The one 401 on the public-read path is the platform
      // refusing the service credential itself — the two
      // servers' PUBLIC_READ_SERVICE_TOKEN values disagree, or
      // one side has none set (Issue #82 review). That is an
      // operations fault, not a verdict on the reader's public
      // token: the token's own verdicts (an unknown token's 404,
      // a revoked token's 401) are schedule's to give, and they
      // are given before any platform call is made. Passing this
      // 401 through would show the reader the revoked token's
      // face for a misconfiguration they cannot act on, so log
      // the fault for the operator — never the credential's
      // value — and answer 503 instead: not available now.
      console.error(
        "platform public-read refused the service credential (401): " +
          "PUBLIC_READ_SERVICE_TOKEN is unset or differs between the platform and schedule servers",
      );
      return { status: 503, body: { error: "ただいま表示できません" } };
    }
    return { status: res.status, body: parsed };
  }

  async function getJson(path: string): Promise<unknown> {
    return unwrapPlatformResult(await request(path));
  }

  function context(schoolId: string, audience: Audience): string {
    return `schoolId=${encodeURIComponent(schoolId)}&audience=${encodeURIComponent(audience)}`;
  }

  return {
    async getSchool(schoolId, audience) {
      const body = await getJson(`${PUBLIC_READ_BASE}/school?${context(schoolId, audience)}`);
      return body as Record_;
    },

    async getHolidays(schoolId, audience, range) {
      const body = await getJson(
        `${PUBLIC_READ_BASE}/calendar/holidays?${context(schoolId, audience)}` +
          `&from=${range.from}&to=${range.to}`,
      );
      return itemsOf(body);
    },

    async getGrades(schoolId, audience) {
      const body = await getJson(
        `${PUBLIC_READ_BASE}/masters/grades?${context(schoolId, audience)}`,
      );
      return itemsOf(body);
    },

    asPlatformClient(schoolId, audience) {
      const requestJson: PlatformApiClient["requestJson"] = async (method, path) => {
        if (method !== "GET") {
          // The public-read path serves reads only; a write name
          // reaching here is refused in the relay shape, like a
          // platform refusal, never rerouted to a member path.
          return {
            status: 405,
            body: { error: "公開読み取りでは書き込みはできません" },
          };
        }
        const [pathname, query = ""] = path.split("?");
        const target =
          pathname === MEMBER_DAYS_PATH
            ? `${PUBLIC_READ_BASE}/calendar/days`
            : pathname === MEMBER_HOLIDAYS_PATH
              ? `${PUBLIC_READ_BASE}/calendar/holidays`
              : pathname === MEMBER_EVENTS_PATH
                ? `${PUBLIC_READ_BASE}/calendar/events`
                : null;
        if (target === null) {
          return { status: 404, body: { error: "見つかりません" } };
        }
        const params = new URLSearchParams(query);
        params.set("schoolId", schoolId);
        params.set("audience", audience);
        return request(`${target}?${params.toString()}`);
      };
      return {
        requestJson,
        getJson: (path) => requestJson("GET", path, ""),
      };
    },
  };
}
