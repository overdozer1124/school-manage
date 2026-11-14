import type { DayType, DutyTermRange } from "@school-manage/calendar-types";
import type { PlatformApiClient } from "../platformClient.js";

/**
 * What the duty logic needs from the platform (Issue #30): the
 * school's staff roster, its recorded calendar days, and its terms.
 * Duty definitions say "long vacation only" or "in term" without
 * naming dates — the platform calendar decides what that means
 * (DESIGN schedule 4.7: 「長期休業の判定には共通基盤の学期と日の種別
 * を使う」), and the rotation roster names the platform's staff
 * masters (DESIGN-INTEGRATION 2.4), whose ids this database cannot
 * check on its own.
 *
 * The shape is an interface so tests inject a fake, the same
 * treatment as the platform client's fetch (platformClient.ts) and
 * the auth layer's fetch (auth.ts). The HTTP implementation below
 * reads through the platform API client with the caller's cookie
 * forwarded, so the platform performs its own permission checks,
 * exactly as DESIGN-INTEGRATION 10 (implementation 1) prescribes.
 * Wiring the cookie from the (not yet built) HTTP layer into the
 * action factories is that layer's work; until then the duty
 * actions run with whatever source the composition root hands them,
 * and refuse the operations that need one when there is none.
 */
export interface DutyStaffEntry {
  id: string;
  active: boolean;
}

export interface DutyCalendarDay {
  date: string;
  dayType: DayType;
}

export interface DutyPlatformSource {
  /** The school's staff master, in the platform's display order. */
  listStaff(schoolId: string): Promise<readonly DutyStaffEntry[]>;
  /** The days the school has recorded in the range (Issue #23's
   *  convention: unrecorded dates do not appear and are derived). */
  listCalendarDays(
    schoolId: string,
    range: { from: string; to: string },
  ): Promise<readonly DutyCalendarDay[]>;
  /** The school's terms, across its school years. */
  listTerms(schoolId: string): Promise<readonly DutyTermRange[]>;
}

interface StaffListBody {
  items?: { id?: unknown; active?: unknown }[];
}

interface DayListBody {
  items?: { date?: unknown; dayType?: unknown }[];
}

function itemsOf<T>(body: unknown): T[] {
  const items = (body as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

/**
 * The platform-API implementation of DutyPlatformSource. The
 * platform's masters and calendar APIs answer for the session's
 * school (a body or query naming another school is refused there),
 * so schoolId is a consistency check on the answers, not a
 * parameter of the requests.
 */
export function createHttpDutyPlatformSource(
  client: PlatformApiClient,
  cookie: string,
): DutyPlatformSource {
  async function getItems<T>(path: string): Promise<T[]> {
    const { status, body } = await client.getJson(path, cookie);
    if (status !== 200) {
      throw new Error(`platform request failed: ${path} -> ${status}`);
    }
    return itemsOf<T>(body);
  }
  return {
    async listStaff() {
      const items = await getItems<NonNullable<StaffListBody["items"]>[number]>("/masters/staff");
      return items
        .filter((i) => typeof i.id === "string")
        .map((i) => ({ id: i.id as string, active: i.active !== false }));
    },
    async listCalendarDays(_schoolId, range) {
      const items = await getItems<NonNullable<DayListBody["items"]>[number]>(
        `/calendar/days?from=${range.from}&to=${range.to}`,
      );
      return items
        .filter((i) => typeof i.date === "string" && typeof i.dayType === "string")
        .map((i) => ({ date: i.date as string, dayType: i.dayType as DayType }));
    },
    async listTerms() {
      // The platform stores terms (its school-year masters) but
      // exposes no terms endpoint yet, so there is nothing honest
      // to read here: fail loudly rather than inventing ranges.
      // Term-scoped duties work as soon as the platform adds the
      // endpoint; until then their preview/apply is refused with
      // this message (all_year, custom_range and
      // long_vacation_only duties never call this).
      throw new Error("the platform has no terms endpoint yet");
    },
  };
}
