import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext, Role } from "@school-manage/platform-client";
import { createScheduleActions } from "../src/composition.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDutyActions } from "../src/duties/actions.js";
import { createHttpDutyPlatformSource } from "../src/duties/platformSource.js";
import type {
  PlatformApiClient,
  PlatformApiMethod,
  PlatformApiResult,
} from "../src/platformClient.js";
import { createViewActions } from "../src/views/actions.js";

// Duty source paths (PR #73 review): the production assembly in
// index.ts builds the range actions through createScheduleActions,
// whose duty source reads through the platform API client. Every
// path that assembly asks for must carry the platform's
// /platform/api/v1 prefix — the range actions' own reads do, and
// the duty source's reads (staff, calendar days, absences) must
// match, or a staff view's getRange fails against the real platform
// with a 404 from the duty source. This test builds the actions
// exactly as index.ts does, records every path handed to a fake
// PlatformApiClient, and runs a staff view's getRange through them.
const url = process.env.SCHEDULE_DATABASE_URL;

const COOKIE = "platform_session=full-token";
const A = "school-a";
const DATE = "2027-10-02";

function itemsFor(path: string): unknown {
  const pathname = path.split("?")[0] as string;
  if (pathname === "/platform/api/v1/masters/staff") {
    return {
      items: [
        { id: "teacher-a1", active: true },
        { id: "teacher-a2", active: true },
      ],
    };
  }
  return { items: [] };
}

class RecordingPlatformClient implements PlatformApiClient {
  paths: string[] = [];
  cookies: string[] = [];

  requestJson(
    _method: PlatformApiMethod,
    path: string,
    cookie: string,
  ): Promise<PlatformApiResult> {
    this.paths.push(path);
    this.cookies.push(cookie);
    return Promise.resolve({ status: 200, body: itemsFor(path) });
  }

  getJson(path: string, cookie: string): Promise<PlatformApiResult> {
    return this.requestJson("GET", path, cookie);
  }
}

function auth(schoolId: string, role: Role): AuthContext {
  return {
    userId: `user-${schoolId}`,
    schoolId,
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

describe.skipIf(!url)("production assembly: duty source paths (Issue #34 review)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let client: RecordingPlatformClient;

  beforeAll(async () => {
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.end();

    const created = createDb(url as string);
    const db: Db = created.db;
    queryClient = created.queryClient;
    await runMigrations(db);

    client = new RecordingPlatformClient();
    const adminA = auth(A, "Admin");

    // Seed through the HTTP duty source itself: a long-vacation
    // duty (its facts come from the platform calendar) and a manual
    // assignment (validated against the platform staff roster).
    const duties = createDutyActions(db, createHttpDutyPlatformSource(client, COOKIE));
    await duties.upsertDutyDefinition.run(adminA, {
      id: "duty-long",
      name: "長期休業当番",
      granularity: "day",
      applicablePeriod: "long_vacation_only",
    });
    await duties.setDutyAssignment.run(adminA, {
      dutyDefinitionId: "duty-long",
      date: DATE,
      slot: "all_day",
      personId: "teacher-a1",
    });
    expect(client.paths).toContain("/platform/api/v1/masters/staff");

    const views = createViewActions(db);
    await views.upsertViewDefinition.run(adminA, {
      id: "view-staff",
      name: "職員用月表",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [{ id: "col-duty", sourceKind: "duty", dutyDefinitionId: "duty-long" }],
    });

    client.paths = [];
    const actions = createScheduleActions(db, client, COOKIE);
    const result = await actions.getRange.run(auth(A, "Editor"), {
      from: "2027-10-01",
      to: "2027-10-03",
      viewId: "view-staff",
      cookie: COOKIE,
    });
    // The derivation ran (no duty-source 404): with no recorded
    // long-vacation days the duty never applies, so no conflicts.
    expect(result.conflicts).toEqual([]);
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("asks the platform only under /platform/api/v1, duty source included", () => {
    expect(client.paths.length).toBeGreaterThan(0);
    for (const path of client.paths) {
      expect(path.startsWith("/platform/api/v1/")).toBe(true);
    }
  });

  it("reads the duty source's absences and calendar days under the prefix", () => {
    expect(client.paths.some((p) => p.startsWith("/platform/api/v1/calendar/absences?"))).toBe(
      true,
    );
    expect(client.paths.some((p) => p.startsWith("/platform/api/v1/calendar/days?"))).toBe(true);
  });
});
