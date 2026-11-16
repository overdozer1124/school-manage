import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthAccessError, type AuthContext, type Role } from "@school-manage/platform-client";
import { createScheduleActions } from "../src/composition.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPlatformApiClient, PlatformRelayError } from "../src/platformClient.js";

// Settings and confirmation-queue tests (Issue #39): the action
// layers of Issues #27 / #32 / #30 / #29 are assembled by the
// production composition and exercised through it — the settings
// writes keep their server-side permissions (definition.write is
// Admin only, so an Editor is refused here, not just hidden on
// the screen), the shared masters are relayed to a fake platform
// that judges writes itself, and the event half of the
// confirmation queue filters and confirms through the relay.
const url = process.env.SCHEDULE_DATABASE_URL;

const COOKIE = "platform_session=test-token";
/** The fake platform refuses this cookie for master writes and
 *  for the pending list: a member who is not a writer in either
 *  product （連携5 not met). */
const VIEWER_COOKIE = "platform_session=viewer-token";
const MASTERS = "/platform/api/v1/masters";
const EVENTS = "/platform/api/v1/calendar/events";

function auth(role: Role): AuthContext {
  return {
    userId: "user-1",
    schoolId: "school-39",
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakePlatform {
  masters = new Map<string, Map<string, Record<string, unknown>>>();
  events = new Map<string, Record<string, unknown>>();
  calls: { method: string; path: string }[] = [];

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace("http://platform.test", "");
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    this.calls.push({ method, path });
    return Promise.resolve(this.route(method, path, body, cookie));
  };

  private route(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
    cookie: string,
  ): Response {
    const master = new RegExp(`^${MASTERS}/([^/]+)(?:/([^/]+))?$`).exec(path);
    if (master) {
      const segment = master[1] as string;
      const store = this.masters.get(segment) ?? new Map<string, Record<string, unknown>>();
      this.masters.set(segment, store);
      if (method === "GET" && !master[2]) {
        return jsonResponse(200, { items: [...store.values()] });
      }
      if (cookie === VIEWER_COOKIE) {
        return jsonResponse(403, { error: "権限がありません" });
      }
      if (method === "POST") {
        const record: Record<string, unknown> = { ...(body ?? {}), revision: 1 };
        store.set(String(record["id"]), record);
        return jsonResponse(201, record);
      }
      const existing = store.get(master[2] as string);
      if (!existing) return jsonResponse(404, { error: "見つかりません" });
      if (method === "PUT") {
        if (body?.["revision"] !== existing["revision"]) {
          return jsonResponse(409, { error: "ほかの人が先に変更しました", latest: existing });
        }
        const record = { ...(body ?? {}), revision: (existing["revision"] as number) + 1 };
        store.set(master[2] as string, record);
        return jsonResponse(200, record);
      }
      if (method === "DELETE") {
        if (body?.["revision"] !== existing["revision"]) {
          return jsonResponse(409, { error: "ほかの人が先に変更しました", latest: existing });
        }
        store.delete(master[2] as string);
        return new Response(null, { status: 204 });
      }
    }
    if (path.startsWith(`${EVENTS}?`) && method === "GET") {
      return jsonResponse(200, { items: [...this.events.values()] });
    }
    const event = new RegExp(`^${EVENTS}/([^/]+)$`).exec(path);
    if (event) {
      const record = this.events.get(event[1] as string);
      if (!record) return jsonResponse(404, { error: "見つかりません" });
      if (method === "GET") return jsonResponse(200, record);
      if (method === "PUT") {
        if (body?.["revision"] !== record["revision"]) {
          return jsonResponse(409, { error: "ほかの人が先に変更しました", latest: record });
        }
        const updated = { ...(body ?? {}), revision: (record["revision"] as number) + 1 };
        this.events.set(event[1] as string, updated);
        return jsonResponse(200, updated);
      }
    }
    return jsonResponse(404, { error: "見つかりません" });
  }
}

/** Every action name the HTTP layer serves (app.ts ACTION_NAMES):
 *  the composition must provide all of them, or the endpoint
 *  answers 404 for a name it claims to know. */
const EXPECTED_ACTIONS = [
  "getBootstrap",
  "getRange",
  "createEvent",
  "updateEvent",
  "deleteEvent",
  "createAbsence",
  "updateAbsence",
  "deleteAbsence",
  "setDailyValue",
  "deleteDailyValue",
  "previewRotation",
  "applyRotation",
  "proposeDutyChange",
  "applyDutyChange",
  "declineDutyChange",
  "getDutyChanges",
  "getDutyConflicts",
  "waiveConflict",
  "getDutyChangeCandidates",
  "getDefinitions",
  "upsertTargetGroup",
  "deleteTargetGroup",
  "upsertTarget",
  "deleteTarget",
  "upsertItemDefinition",
  "deleteItemDefinition",
  "upsertLocation",
  "deleteLocation",
  "saveSettings",
  "applyPreset",
  "getViews",
  "upsertViewDefinition",
  "deleteViewDefinition",
  "updateViewColumnWidth",
  "getDutyDefinitions",
  "upsertDutyDefinition",
  "deleteDutyDefinition",
  "getDutyAssignments",
  "setDutyAssignment",
  "moveEvent",
  "moveAbsence",
  "getEventValues",
  "setEventValues",
  "getKindTemplates",
  "upsertKindTemplate",
  "deleteKindTemplate",
  "applyDefaultKindTemplates",
  "getPendingAbsences",
  "confirmAbsence",
  "getPendingEvents",
  "confirmEvent",
  "getMasters",
  "createMaster",
  "updateMaster",
  "deleteMaster",
  "createPublication",
  "getPublications",
  "getPublication",
  "createPublicViewToken",
  "getPublicViewTokens",
  "revokePublicViewToken",
];

describe.skipIf(!url)("settings screens' server side (Issue #39)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let fake: FakePlatform;
  let actions: ReturnType<typeof createScheduleActions>;

  beforeAll(async () => {
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.end();

    const created = createDb(url);
    const db: Db = created.db;
    queryClient = created.queryClient;
    await runMigrations(db);
    fake = new FakePlatform();
    const client = createPlatformApiClient({
      baseUrl: "http://platform.test",
      fetchImpl: fake.fetch,
    });
    actions = createScheduleActions(db, client, COOKIE);
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("the composition provides every action the HTTP layer serves", () => {
    for (const name of EXPECTED_ACTIONS) {
      expect(actions, `missing action: ${name}`).toHaveProperty(name);
    }
  });

  it("definition writes are Admin's on the server, not just hidden on the screen", async () => {
    const input = {
      id: "item-meeting-39",
      key: "meeting",
      name: "会議",
      valueType: "event_list",
      granularity: "day",
      defaultVisibility: "staff_only",
    };
    await expect(actions.upsertItemDefinition.run(auth("Editor"), input)).rejects.toBeInstanceOf(
      AuthAccessError,
    );
    await expect(
      actions.upsertViewDefinition.run(auth("Editor"), {
        id: "view-39",
        name: "会議表",
        layout: "month_rows",
        audience: "staff",
        periodScope: "month",
        columns: [],
      }),
    ).rejects.toBeInstanceOf(AuthAccessError);
    // The same writes succeed for an Admin, and the new item is
    // offerable as a view column (DESIGN 5.2 scenario 7).
    await actions.upsertItemDefinition.run(auth("Admin"), input);
    const view = await actions.upsertViewDefinition.run(auth("Admin"), {
      id: "view-39",
      name: "会議表",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [
        { id: "col-39", sourceKind: "daily_item", itemDefinitionId: "item-meeting-39", sort: 1 },
      ],
    });
    expect(view.columns.map((c) => c.itemDefinitionId)).toEqual(["item-meeting-39"]);
    const definitions = await actions.getDefinitions.run(auth("Admin"), {});
    expect(definitions.itemDefinitions.map((i) => i.key)).toContain("meeting");
  });

  it("relays the shared masters to the platform, which judges the writes", async () => {
    const created = (await actions.createMaster.run(auth("Admin"), {
      cookie: COOKIE,
      kind: "grade",
      record: { id: "grade-7", name: "7年", sortOrder: 7, stage: null },
    })) as Record<string, unknown>;
    expect(created["revision"]).toBe(1);
    expect(fake.calls.some((c) => c.method === "POST" && c.path === `${MASTERS}/grades`)).toBe(
      true,
    );

    const masters = (await actions.getMasters.run(auth("Admin"), { cookie: COOKIE })) as Record<
      string,
      Record<string, unknown>[]
    >;
    expect(masters["grade"]?.map((g) => g["id"])).toContain("grade-7");

    const updated = (await actions.updateMaster.run(auth("Admin"), {
      cookie: COOKIE,
      kind: "grade",
      id: "grade-7",
      record: { id: "grade-7", name: "7年", sortOrder: 7, stage: "後期課程", revision: 1 },
    })) as Record<string, unknown>;
    expect(updated["revision"]).toBe(2);

    // A stale revision is the platform's 409, relayed as-is.
    await expect(
      actions.updateMaster.run(auth("Admin"), {
        cookie: COOKIE,
        kind: "grade",
        id: "grade-7",
        record: { id: "grade-7", name: "7年", sortOrder: 7, stage: null, revision: 1 },
      }),
    ).rejects.toMatchObject({ status: 409 });

    // A caller the platform will not let write gets its 403.
    await expect(
      actions.createMaster.run(auth("Admin"), {
        cookie: VIEWER_COOKIE,
        kind: "grade",
        record: { id: "grade-8", name: "8年", sortOrder: 8, stage: null },
      }),
    ).rejects.toBeInstanceOf(PlatformRelayError);

    await actions.deleteMaster.run(auth("Admin"), {
      cookie: COOKIE,
      kind: "grade",
      id: "grade-7",
      revision: 2,
    });
    const after = (await actions.getMasters.run(auth("Admin"), { cookie: COOKIE })) as Record<
      string,
      Record<string, unknown>[]
    >;
    expect(after["grade"]?.map((g) => g["id"])).not.toContain("grade-7");
  });

  it("the pending events are the tentative ones, and confirming flips only the certainty", async () => {
    fake.events.set("ev-tentative", {
      id: "ev-tentative",
      kind: "other",
      kindLabel: "出張",
      title: "生徒指導担当（出張）",
      datePrecision: "day",
      startsOn: "2026-11-19",
      endsOn: "2026-11-19",
      certainty: "tentative",
      visibility: "staff_only",
      revision: 3,
    });
    fake.events.set("ev-confirmed", {
      id: "ev-confirmed",
      kind: "event",
      kindLabel: null,
      title: "授業参観",
      datePrecision: "day",
      startsOn: "2026-11-06",
      endsOn: "2026-11-06",
      certainty: "confirmed",
      visibility: "guardian",
      revision: 1,
    });

    const pending = (await actions.getPendingEvents.run(auth("Editor"), {
      cookie: COOKIE,
      from: "2025-04-01",
      to: "2028-03-31",
    })) as { items: Record<string, unknown>[] };
    expect(pending.items.map((i) => i["id"])).toEqual(["ev-tentative"]);

    const confirmed = (await actions.confirmEvent.run(auth("Editor"), {
      cookie: COOKIE,
      id: "ev-tentative",
      revision: 3,
    })) as Record<string, unknown>;
    expect(confirmed["certainty"]).toBe("confirmed");
    expect(confirmed["title"]).toBe("生徒指導担当（出張）");
    expect(confirmed["revision"]).toBe(4);

    // A stale revision is the platform's 409, relayed as-is.
    await expect(
      actions.confirmEvent.run(auth("Editor"), {
        cookie: COOKIE,
        id: "ev-confirmed",
        revision: 99,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
