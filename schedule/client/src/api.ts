import type {
  ApplyRotationResultData,
  BootstrapData,
  DutyChangeData,
  DutyConflictData,
  EventValueData,
  RangeData,
  RotationPlanCellData,
  TargetRefData,
} from "./types";

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

/** The answer of a relayed create / update: the platform record as
 *  the platform returned it, plus the additional items saved with
 *  it (empty for creates without values, null for updates). */
export interface RelaySaveResult {
  record: Record<string, unknown>;
  values: unknown[] | null;
}

export interface DutyChangeProposal {
  kind: "swap" | "substitute" | "reassign";
  assignmentAId: string;
  assignmentBId?: string | null;
  toPersonId?: string | null;
  reason?: string;
}

export interface ScheduleApi {
  getBootstrap(): Promise<BootstrapData>;
  getRange(input: { from: string; to: string; viewId: string }): Promise<RangeData>;
  // Issue #35: the cell editors' writes. Events and absences are
  // relayed to the platform, which judges them; daily values are
  // schedule's own writes.
  createEvent(input: { event: Record<string, unknown> }): Promise<RelaySaveResult>;
  updateEvent(input: {
    id: string;
    revision: number;
    event: Record<string, unknown>;
  }): Promise<RelaySaveResult>;
  deleteEvent(input: { id: string; revision: number }): Promise<{ deleted: true }>;
  createAbsence(input: { absence: Record<string, unknown> }): Promise<RelaySaveResult>;
  updateAbsence(input: {
    id: string;
    revision: number;
    absence: Record<string, unknown>;
  }): Promise<RelaySaveResult>;
  deleteAbsence(input: { id: string; revision: number }): Promise<{ deleted: true }>;
  setDailyValue(input: {
    date: string;
    itemDefinitionId: string;
    target?: TargetRefData | null;
    value: unknown;
  }): Promise<unknown>;
  deleteDailyValue(input: {
    date: string;
    itemDefinitionId: string;
    target?: TargetRefData | null;
  }): Promise<{ deleted: true }>;
  // Issue #36: the quick-entry popover's item step. A record's
  // additional items (Issue #29) are read as one set and rewritten
  // as one set — the write replaces the whole set, so the popover
  // reads first and sends the set back with its one item changed.
  getEventValues(input: {
    subjectKind: "event" | "absence";
    subjectId: string;
  }): Promise<EventValueData[]>;
  setEventValues(input: {
    subjectKind: "event" | "absence";
    subjectId: string;
    values: { itemDefinitionId: string; target?: TargetRefData | null; value: unknown }[];
  }): Promise<unknown>;
  // The duty panel's actions (Issue #38), served by the same
  // endpoints: the rotation preview / apply of Issue #30 and the
  // change / conflict operations of Issue #31.
  previewRotation(input: {
    dutyDefinitionId: string;
    from: string;
    to: string;
    slots?: string[];
  }): Promise<RotationPlanCellData[]>;
  applyRotation(input: {
    dutyDefinitionId: string;
    from: string;
    to: string;
    slots?: string[];
  }): Promise<ApplyRotationResultData>;
  proposeDutyChange(input: DutyChangeProposal): Promise<DutyChangeData>;
  applyDutyChange(input: { id: string }): Promise<DutyChangeData>;
  declineDutyChange(input: { id: string }): Promise<DutyChangeData>;
  getDutyChanges(input?: { dutyDefinitionId?: string }): Promise<DutyChangeData[]>;
  getDutyConflicts(input: {
    from: string;
    to: string;
    dutyDefinitionId?: string;
  }): Promise<DutyConflictData[]>;
  waiveConflict(input: {
    assignmentId: string;
    absenceId: string;
    reason?: string;
  }): Promise<unknown>;
  getDutyChangeCandidates(input: { assignmentId: string }): Promise<string[]>;
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
    createEvent: (input) => call<RelaySaveResult>("createEvent", input),
    updateEvent: (input) => call<RelaySaveResult>("updateEvent", input),
    deleteEvent: (input) => call<{ deleted: true }>("deleteEvent", input),
    createAbsence: (input) => call<RelaySaveResult>("createAbsence", input),
    updateAbsence: (input) => call<RelaySaveResult>("updateAbsence", input),
    deleteAbsence: (input) => call<{ deleted: true }>("deleteAbsence", input),
    setDailyValue: (input) => call<unknown>("setDailyValue", input),
    deleteDailyValue: (input) => call<{ deleted: true }>("deleteDailyValue", input),
    getEventValues: (input) => call<EventValueData[]>("getEventValues", input),
    setEventValues: (input) => call<unknown>("setEventValues", input),
    previewRotation: (input) => call<RotationPlanCellData[]>("previewRotation", input),
    applyRotation: (input) => call<ApplyRotationResultData>("applyRotation", input),
    proposeDutyChange: (input) => call<DutyChangeData>("proposeDutyChange", input),
    applyDutyChange: (input) => call<DutyChangeData>("applyDutyChange", input),
    declineDutyChange: (input) => call<DutyChangeData>("declineDutyChange", input),
    getDutyChanges: (input) => call<DutyChangeData[]>("getDutyChanges", input ?? {}),
    getDutyConflicts: (input) => call<DutyConflictData[]>("getDutyConflicts", input),
    waiveConflict: (input) => call<unknown>("waiveConflict", input),
    getDutyChangeCandidates: (input) => call<string[]>("getDutyChangeCandidates", input),
  };
}

/** The platform login URL a 401 sends the person to (8-3-1: the
 *  platform lives on the same domain, at /login). */
export function platformLoginUrl(): string {
  return "/login";
}
