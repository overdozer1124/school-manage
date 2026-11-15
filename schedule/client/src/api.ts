import type { BootstrapData, RangeData } from "./types";

/**
 * The screens' API口 (Issue #34): the only place the client talks to
 * the schedule server. Calls go to the action endpoints served under
 * the same `/{slug}/schedule/` path the page itself was delivered
 * from, so the session cookie rides along untouched and the platform
 * keeps making the permission judgments (DESIGN-INTEGRATION 10).
 *
 * 401 and 403 are kept apart, as DESIGN-AUTH-TENANCY 4.8 requires:
 * a 401 throws UnauthorizedError (the app sends the person to the
 * platform's login), a 403 throws ForbiddenError (the app shows
 * 「権限がありません」). Any other failure is a plain ApiError.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "認証が必要です") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "権限がありません") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export interface ScheduleApi {
  getBootstrap(): Promise<BootstrapData>;
  getRange(input: { from: string; to: string; viewId: string }): Promise<RangeData>;
}

export interface ScheduleApiOptions {
  /** Base of the action endpoints, relative to the page by default:
   *  the page is served from `/{slug}/schedule/`, the endpoints live
   *  under `/{slug}/schedule/api/`. */
  baseUrl?: string;
  /** Tests inject a fake; the default is the global fetch. */
  fetchImpl?: typeof fetch;
  /** Where a 401 sends the person (the platform's login page). */
  loginUrl?: string;
}

export function createScheduleApi(options: ScheduleApiOptions = {}): ScheduleApi {
  const baseUrl = (options.baseUrl ?? "./api").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  async function call<T>(action: string, request: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(request ?? {}),
      });
    } catch {
      throw new ApiError(0, "サーバーに接続できませんでした");
    }
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 401) {
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? ((body as { error: string }).error as string)
          : undefined;
      throw new UnauthorizedError(message);
    }
    if (res.status === 403) {
      throw new ForbiddenError();
    }
    if (res.status < 200 || res.status >= 300) {
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? ((body as { error: string }).error as string)
          : `サーバーが ${res.status} を返しました`;
      throw new ApiError(res.status, message);
    }
    return body as T;
  }

  return {
    getBootstrap: () => call<BootstrapData>("getBootstrap", {}),
    getRange: (input) => call<RangeData>("getRange", input),
  };
}

/** The platform login URL a 401 sends the person to (8-3-1: the
 *  platform lives on the same domain, at /login). */
export function platformLoginUrl(): string {
  return "/login";
}
