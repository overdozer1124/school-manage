import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthContext, type Role } from "@school-manage/platform-client";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createDefinitionActions } from "../src/definitions/actions.js";
import { createEventActions, EventValuesSaveError } from "../src/events/actions.js";
import { createPlatformApiClient, PlatformRelayError } from "../src/platformClient.js";

// Event relay tests (Issue #29): the schedule server relays event
// and absence saves to a fake platform (an in-memory fetch), stores
// the additional items (event_values) in its own database after the
// platform save succeeds, and serves the kind templates. The fake
// platform keeps records in Maps and answers with the real API's
// verdicts, including 403 and revision-conflict 409s.
const url = process.env.SCHEDULE_DATABASE_URL;

const COOKIE = "platform_session=test-token";
/** The fake platform refuses this cookie at the write-check: a
 *  member the platform will not let write (連携5 not met). */
const VIEWER_COOKIE = "platform_session=viewer-token";
const EVENTS = "/platform/api/v1/calendar/events";
const ABSENCES = "/platform/api/v1/calendar/absences";

interface FakeCall {
  method: string;
  path: string;
  cookie: string | undefined;
  body: Record<string, unknown> | null;
}

interface FakeFailure {
  method: string;
  pathPrefix: string;
  status: number;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakePlatform {
  calls: FakeCall[] = [];
  failures: FakeFailure[] = [];
  events = new Map<string, Record<string, unknown>>();
  absences = new Map<string, Record<string, unknown>>();

  countCalls(method: string, pathPrefix: string): number {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix)).length;
  }

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace("http://platform.test", "");
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.calls.push({
      method,
      path,
      cookie: new Headers(init?.headers).get("cookie") ?? undefined,
      body,
    });
    const failure = this.failures.find((f) => f.method === method && path.startsWith(f.pathPrefix));
    if (failure) return Promise.resolve(jsonResponse(failure.status, failure.body));
    const cookie = new Headers(init?.headers).get("cookie") ?? undefined;
    return Promise.resolve(this.route(method, path, body, cookie));
  };

  private route(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
    cookie?: string,
  ): Response {
    if (path === `${ABSENCES}/pending` && method === "GET") {
      const items = [...this.absences.values()].filter((a) => a.certainty === "tentative");
      return jsonResponse(200, { items });
    }
    const confirm = /^(.+)\/([^/]+)\/confirm$/.exec(path);
    if (confirm && method === "POST") {
      const store = confirm[1] === ABSENCES ? this.absences : this.events;
      const record = store.get(confirm[2] as string);
      if (!record) return jsonResponse(404, { error: "見つかりません" });
      if (body?.revision !== record.revision) {
        return jsonResponse(409, { error: "ほかの人が先に変更しました", latest: record });
      }
      const confirmed = {
        ...record,
        certainty: "confirmed",
        revision: (record.revision as number) + 1,
      };
      store.set(confirm[2] as string, confirmed);
      return jsonResponse(200, confirmed);
    }
    const writeCheck = /^(.+)\/([^/]+)\/write-check$/.exec(path);
    if (writeCheck && method === "GET") {
      const store = writeCheck[1] === ABSENCES ? this.absences : this.events;
      if (!store.has(writeCheck[2] as string)) {
        return jsonResponse(404, { error: "見つかりません" });
      }
      if (cookie === VIEWER_COOKIE) {
        return jsonResponse(403, { error: "権限がありません" });
      }
      return jsonResponse(200, { writable: true });
    }
    for (const [base, store] of [
      [EVENTS, this.events],
      [ABSENCES, this.absences],
    ] as const) {
      if (path === base && method === "POST") {
        const record: Record<string, unknown> = { ...(body ?? {}), revision: 1 };
        store.set(record.id as string, record);
        return jsonResponse(201, record);
      }
      if (path.startsWith(`${base}/`)) {
        const id = decodeURIComponent(path.slice(base.length + 1));
        const record = store.get(id);
        if (method === "GET") {
          return record
            ? jsonResponse(200, record)
            : jsonResponse(404, { error: "見つかりません" });
        }
        if (!record) return jsonResponse(404, { error: "見つかりません" });
        if (body?.revision !== record.revision) {
          return jsonResponse(409, { error: "ほかの人が先に変更しました", latest: record });
        }
        if (method === "PUT") {
          const stored = {
            ...(body as Record<string, unknown>),
            revision: (record.revision as number) + 1,
          };
          store.set(id, stored);
          return jsonResponse(200, stored);
        }
        if (method === "DELETE") {
          store.delete(id);
          return new Response(null, { status: 204 });
        }
      }
    }
    return jsonResponse(404, { error: "見つかりません" });
  }
}

type EventActions = ReturnType<typeof createEventActions>;

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

const A = "school-a";
const B = "school-b";

const eventPayload = (id: string) => ({
  id,
  title: "運動会",
  kind: "event",
  kindLabel: null,
  datePrecision: "day",
  startsOn: "2027-10-02",
  endsOn: "2027-10-02",
  time: null,
  locationId: null,
  locationText: null,
  description: null,
  certainty: "confirmed",
  visibility: "staff_only",
  targets: [],
  impacts: [],
  assignees: [],
});

const absencePayload = (id: string) => ({
  id,
  staffId: "staff-1",
  fromDate: "2027-05-10",
  toDate: "2027-05-11",
  time: { kind: "all_day" },
  kind: "business_trip",
  certainty: "tentative",
  purpose: "研修会",
  note: null,
  subdivisionKey: null,
});

describe.skipIf(!url)("schedule event relay, values and kind templates", () => {
  let queryClient: ReturnType<typeof postgres>;
  let fake: FakePlatform;
  let actions: EventActions;

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
    actions = createEventActions(db, client);

    // Item definitions: a free-text item (a deadline's destination),
    // a code item (a trip's form, with options — a bad code is how a
    // values save fails after the body succeeded), and a grade-axis
    // text item for per-target values. School B gets its own text
    // item under the same key.
    const defs = createDefinitionActions(db);
    await defs.upsertItemDefinition.run(auth(A, "Admin"), {
      id: "item-submit-a",
      key: "submit_to",
      name: "提出先",
      valueType: "text",
      granularity: "day",
      defaultVisibility: "staff_only",
    });
    await defs.upsertItemDefinition.run(auth(A, "Admin"), {
      id: "item-trip-form-a",
      key: "trip_form",
      name: "出張形態",
      valueType: "code",
      granularity: "day",
      defaultVisibility: "staff_only",
      options: [
        { id: "opt-onsite", code: "onsite", label: "現地", sort: 1 },
        { id: "opt-remote", code: "remote", label: "オンライン", sort: 2 },
      ],
    });
    await defs.upsertItemDefinition.run(auth(A, "Admin"), {
      id: "item-grade-note-a",
      key: "grade_note",
      name: "学年メモ",
      valueType: "text",
      targetPlatformAxis: "grade",
      granularity: "day",
      defaultVisibility: "staff_only",
    });
    await defs.upsertItemDefinition.run(auth(B, "Admin"), {
      id: "item-submit-b",
      key: "submit_to",
      name: "提出先",
      valueType: "text",
      granularity: "day",
      defaultVisibility: "staff_only",
    });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("relays a create with the user's cookie and stores the additional items after it succeeds", async () => {
    const editor = auth(A, "Editor");
    const before = fake.calls.length;
    const result = await actions.createEvent.run(editor, {
      cookie: COOKIE,
      event: eventPayload("ev-1"),
      values: [{ itemDefinitionId: "item-submit-a", value: "教育委員会" }],
    });
    expect((result.record as { revision: number }).revision).toBe(1);
    expect(result.values).toHaveLength(1);
    expect(result.values[0]?.valueText).toBe("教育委員会");

    const post = fake.calls.slice(before).find((c) => c.method === "POST");
    expect(post?.path).toBe(EVENTS);
    expect(post?.cookie).toBe(COOKIE);
    expect(post?.body?.title).toBe("運動会");

    const read = await actions.getEventValues.run(auth(A, "Viewer"), {
      cookie: COOKIE,
      subjectKind: "event",
      subjectId: "ev-1",
    });
    expect(read.map((v) => v.valueText)).toEqual(["教育委員会"]);
  });

  it("stores per-target values for an event, the target kept as a TargetRef", async () => {
    const result = await actions.createEvent.run(auth(A, "Editor"), {
      cookie: COOKIE,
      event: eventPayload("ev-2"),
      values: [
        {
          itemDefinitionId: "item-grade-note-a",
          target: { axis: "grade", id: "grade-3" },
          value: "3年は午前のみ",
        },
      ],
    });
    expect(result.values[0]?.targetKey).toBe("grade:grade-3");
    expect(result.values[0]?.targetRef).toEqual({ axis: "grade", id: "grade-3" });
  });

  it("saves no values when the platform refuses the body (403 passes through)", async () => {
    fake.failures.push({
      method: "POST",
      pathPrefix: EVENTS,
      status: 403,
      body: { error: "権限がありません" },
    });
    const error = await actions.createEvent
      .run(auth(A, "Editor"), {
        cookie: COOKIE,
        event: eventPayload("ev-refused"),
        values: [{ itemDefinitionId: "item-submit-a", value: "教育委員会" }],
      })
      .catch((e: unknown) => e);
    fake.failures = [];
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect(error).toMatchObject({ status: 403, body: { error: "権限がありません" } });
    expect(fake.events.has("ev-refused")).toBe(false);
    expect(
      await actions.getEventValues.run(auth(A, "Admin"), {
        cookie: COOKIE,
        subjectKind: "event",
        subjectId: "ev-refused",
      }),
    ).toEqual([]);
  });

  it("keeps the body when the values fail, and a retry lands the values only", async () => {
    const editor = auth(A, "Editor");
    const error = await actions.createEvent
      .run(editor, {
        cookie: COOKIE,
        event: eventPayload("ev-retry"),
        values: [{ itemDefinitionId: "item-trip-form-a", value: "teleport" }],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EventValuesSaveError);
    const saveError = error as EventValuesSaveError;
    expect(saveError.subjectKind).toBe("event");
    expect(saveError.subjectId).toBe("ev-retry");
    expect((saveError.record as { title: string }).title).toBe("運動会");
    // The body stands on its own in the platform; no values landed.
    expect(fake.events.get("ev-retry")?.title).toBe("運動会");
    expect(
      await actions.getEventValues.run(editor, {
        cookie: COOKIE,
        subjectKind: "event",
        subjectId: "ev-retry",
      }),
    ).toEqual([]);

    const postsBefore = fake.countCalls("POST", EVENTS);
    const saved = await actions.setEventValues.run(editor, {
      cookie: COOKIE,
      subjectKind: "event",
      subjectId: "ev-retry",
      values: [{ itemDefinitionId: "item-trip-form-a", value: "onsite" }],
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.valueOptionId).toBe("opt-onsite");
    // The retry touched the values only: no second platform save.
    expect(fake.countCalls("POST", EVENTS)).toBe(postsBefore);
    // But it did ask the platform's write-check first (Issue #29
    // review): the platform, not this server's role table, decides
    // who may set a record's values.
    expect(fake.countCalls("GET", `${EVENTS}/ev-retry/write-check`)).toBe(1);
  });

  it("passes a platform 409 on update through with its body, values untouched", async () => {
    const editor = auth(A, "Editor");
    const created = await actions.createEvent.run(editor, {
      cookie: COOKIE,
      event: eventPayload("ev-conflict"),
      values: [{ itemDefinitionId: "item-submit-a", value: "校長室" }],
    });
    expect(created.values).toHaveLength(1);

    const error = await actions.updateEvent
      .run(editor, {
        cookie: COOKIE,
        id: "ev-conflict",
        revision: 99,
        event: eventPayload("ev-conflict"),
        values: [{ itemDefinitionId: "item-submit-a", value: "教育委員会" }],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect(error).toMatchObject({ status: 409 });
    expect((error as PlatformRelayError).body).toMatchObject({ latest: { revision: 1 } });
    const values = await actions.getEventValues.run(editor, {
      cookie: COOKIE,
      subjectKind: "event",
      subjectId: "ev-conflict",
    });
    expect(values.map((v) => v.valueText)).toEqual(["校長室"]);
  });

  it("replaces values wholesale on update, moves by dates only, and deletes values with the body", async () => {
    const editor = auth(A, "Editor");
    const updated = await actions.updateEvent.run(editor, {
      cookie: COOKIE,
      id: "ev-conflict",
      revision: 1,
      event: { ...eventPayload("ev-conflict"), title: "運動会（順延）" },
      values: [{ itemDefinitionId: "item-submit-a", value: "教育委員会" }],
    });
    expect((updated.record as { revision: number }).revision).toBe(2);
    expect(updated.values?.map((v) => v.valueText)).toEqual(["教育委員会"]);

    const moved = (await actions.moveEvent.run(editor, {
      cookie: COOKIE,
      id: "ev-conflict",
      revision: 2,
      startsOn: "2027-10-09",
      endsOn: "2027-10-09",
    })) as { startsOn: string; title: string; revision: number };
    expect(moved.startsOn).toBe("2027-10-09");
    expect(moved.title).toBe("運動会（順延）");
    expect(moved.revision).toBe(3);
    // A move does not touch the values.
    expect(
      (
        await actions.getEventValues.run(editor, {
          cookie: COOKIE,
          subjectKind: "event",
          subjectId: "ev-conflict",
        })
      ).map((v) => v.valueText),
    ).toEqual(["教育委員会"]);

    await actions.deleteEvent.run(editor, { cookie: COOKIE, id: "ev-conflict", revision: 3 });
    expect(fake.events.has("ev-conflict")).toBe(false);
    expect(
      await actions.getEventValues.run(editor, {
        cookie: COOKIE,
        subjectKind: "event",
        subjectId: "ev-conflict",
      }),
    ).toEqual([]);
  });

  it("relays the absence flow: create with values, pending list, confirm, move, delete", async () => {
    const editor = auth(A, "Editor");
    const created = await actions.createAbsence.run(editor, {
      cookie: COOKIE,
      absence: absencePayload("abs-1"),
      values: [{ itemDefinitionId: "item-trip-form-a", value: "remote" }],
    });
    expect((created.record as { certainty: string }).certainty).toBe("tentative");
    expect(created.values[0]?.valueOptionId).toBe("opt-remote");

    const pending = (await actions.getPendingAbsences.run(editor, { cookie: COOKIE })) as {
      items: { id: string }[];
    };
    expect(pending.items.map((i) => i.id)).toContain("abs-1");

    const confirmed = (await actions.confirmAbsence.run(editor, {
      cookie: COOKIE,
      id: "abs-1",
      revision: 1,
    })) as { certainty: string; revision: number };
    expect(confirmed.certainty).toBe("confirmed");
    expect(confirmed.revision).toBe(2);

    const moved = (await actions.moveAbsence.run(editor, {
      cookie: COOKIE,
      id: "abs-1",
      revision: 2,
      fromDate: "2027-05-17",
      toDate: "2027-05-18",
    })) as { fromDate: string; toDate: string };
    expect(moved.fromDate).toBe("2027-05-17");
    expect(moved.toDate).toBe("2027-05-18");

    await actions.deleteAbsence.run(editor, { cookie: COOKIE, id: "abs-1", revision: 3 });
    expect(fake.absences.has("abs-1")).toBe(false);
    expect(
      await actions.getEventValues.run(editor, {
        cookie: COOKIE,
        subjectKind: "absence",
        subjectId: "abs-1",
      }),
    ).toEqual([]);
  });

  it("keeps two schools' values and item references apart", async () => {
    // School B cannot read school A's values for the same subject id.
    expect(
      await actions.getEventValues.run(auth(B, "Admin"), {
        cookie: COOKIE,
        subjectKind: "event",
        subjectId: "ev-1",
      }),
    ).toEqual([]);
    // Nor save values against school A's item definition: the item
    // is looked up in the caller's school and is not there.
    await expect(
      actions.setEventValues.run(auth(B, "Editor"), {
        cookie: COOKIE,
        subjectKind: "event",
        subjectId: "ev-1",
        values: [{ itemDefinitionId: "item-submit-a", value: "x" }],
      }),
    ).rejects.toThrow(/item definition not found/);
    // School B's own item under the same key works for B.
    const saved = await actions.setEventValues.run(auth(B, "Editor"), {
      cookie: COOKIE,
      subjectKind: "event",
      subjectId: "ev-1",
      values: [{ itemDefinitionId: "item-submit-b", value: "B校の提出先" }],
    });
    expect(saved[0]?.schoolId).toBe(B);
    expect(
      (
        await actions.getEventValues.run(auth(A, "Admin"), {
          cookie: COOKIE,
          subjectKind: "event",
          subjectId: "ev-1",
        })
      ).map((v) => v.valueText),
    ).toEqual(["教育委員会"]);
  });

  it("ships four default kind templates; leave has a subdivision step and no location step", async () => {
    const admin = auth(A, "Admin");
    const templates = await actions.applyDefaultKindTemplates.run(admin, null);
    expect(templates.map((t) => t.key)).toEqual(["event", "business_trip", "deadline", "leave"]);

    const leave = templates.find((t) => t.key === "leave");
    const stepKinds = (leave?.steps ?? []).map((s) => s.kind);
    expect(stepKinds).toEqual(["person", "subdivision", "time"]);
    expect(stepKinds).not.toContain("location");
    expect(leave?.personLabel).toBe("取得者");
    expect(leave?.displaySource).toBe("person");
    // Business trips and leave record that the platform stores
    // them as absences, not events (Issue #29).
    expect(templates.find((t) => t.key === "business_trip")?.subjectKind).toBe("absence");
    expect(leave?.subjectKind).toBe("absence");
    expect(templates.find((t) => t.key === "event")?.subjectKind).toBe("event");
    // 〆切 takes its own item step in place of the location (6.5).
    const deadline = templates.find((t) => t.key === "deadline");
    expect((deadline?.steps ?? []).map((s) => s.kind)).toEqual(["person", "item", "time"]);

    // Re-applying never overwrites a template the school changed.
    await actions.upsertKindTemplate.run(admin, {
      id: "tpl-leave",
      key: "leave",
      name: "休暇",
      subjectKind: "absence",
      kindCode: "leave",
      personLabel: "休暇を取る人",
      displaySource: "person",
      steps: [{ kind: "person" }, { kind: "subdivision" }, { kind: "time" }],
      itemDefinitionIds: [],
      sort: 4,
    });
    const again = await actions.applyDefaultKindTemplates.run(admin, null);
    expect(again).toHaveLength(4);
    expect(again.find((t) => t.key === "leave")?.personLabel).toBe("休暇を取る人");
  });

  it("guards the templates: view.read to read, definition.write (Admin) to change", async () => {
    await expect(
      actions.upsertKindTemplate.run(auth(A, "Editor"), {
        id: "tpl-meeting",
        key: "meeting",
        name: "会議",
        subjectKind: "event",
        kindCode: "meeting",
        personLabel: "担当者",
        displaySource: "title",
        steps: [{ kind: "person" }, { kind: "time" }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    const read = await actions.getKindTemplates.run(auth(A, "Viewer"), null);
    expect(read.map((t) => t.key)).toContain("leave");

    // A kind code of the other subject is refused before any write.
    await expect(
      actions.upsertKindTemplate.run(auth(A, "Admin"), {
        id: "tpl-bad",
        key: "bad",
        name: "不正",
        subjectKind: "event",
        kindCode: "leave",
        personLabel: "担当者",
        displaySource: "title",
        steps: [],
      }),
    ).rejects.toThrow(/not a event kind code/);
    // Keys are unique per school, not across schools.
    await expect(
      actions.upsertKindTemplate.run(auth(A, "Admin"), {
        id: "tpl-leave-2",
        key: "leave",
        name: "休暇2",
        subjectKind: "absence",
        kindCode: "leave",
        personLabel: "取得者",
        displaySource: "person",
        steps: [],
      }),
    ).rejects.toThrow(/kind template key already exists/);
    const other = await actions.upsertKindTemplate.run(auth(B, "Admin"), {
      id: "tpl-leave-b",
      key: "leave",
      name: "休暇",
      subjectKind: "absence",
      kindCode: "leave",
      personLabel: "取得者",
      displaySource: "person",
      steps: [{ kind: "person" }, { kind: "subdivision" }, { kind: "time" }],
    });
    expect(other.schoolId).toBe(B);
    expect(await actions.getKindTemplates.run(auth(B, "Admin"), null)).toHaveLength(1);
  });

  it("refuses a values-only save the platform will not let the caller write", async () => {
    const editor = auth(A, "Editor");
    await actions.createEvent.run(editor, {
      cookie: COOKIE,
      event: eventPayload("ev-guarded"),
      values: [{ itemDefinitionId: "item-submit-a", value: "教育委員会" }],
    });
    // A caller the platform refuses at the write-check (the fake
    // refuses the viewer cookie, as the real guard refuses a
    // Viewer): the platform's 403 comes back as-is, exactly like a
    // refused save, and nothing is written.
    const error = await actions.setEventValues
      .run(auth(A, "Viewer"), {
        cookie: VIEWER_COOKIE,
        subjectKind: "event",
        subjectId: "ev-guarded",
        values: [{ itemDefinitionId: "item-submit-a", value: "職員室" }],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect(error).toMatchObject({ status: 403 });
    const values = await actions.getEventValues.run(editor, {
      cookie: COOKIE,
      subjectKind: "event",
      subjectId: "ev-guarded",
    });
    expect(values.map((v) => v.valueText)).toEqual(["教育委員会"]);
  });

  it("refuses a values-only save for a subject the platform does not have", async () => {
    const error = await actions.setEventValues
      .run(auth(A, "Editor"), {
        cookie: COOKIE,
        subjectKind: "event",
        subjectId: "ev-missing",
        values: [{ itemDefinitionId: "item-submit-a", value: "x" }],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformRelayError);
    expect(error).toMatchObject({ status: 404 });
    // And for an absence that is not there either.
    const absenceError = await actions.setEventValues
      .run(auth(A, "Editor"), {
        cookie: COOKIE,
        subjectKind: "absence",
        subjectId: "abs-missing",
        values: [{ itemDefinitionId: "item-submit-a", value: "x" }],
      })
      .catch((e: unknown) => e);
    expect(absenceError).toBeInstanceOf(PlatformRelayError);
    expect(absenceError).toMatchObject({ status: 404 });
  });

  it("serves an absence's values only when the platform shows the caller the record's texts", async () => {
    const editor = auth(A, "Editor");
    await actions.createAbsence.run(editor, {
      cookie: COOKIE,
      absence: absencePayload("abs-values"),
      values: [{ itemDefinitionId: "item-trip-form-a", value: "remote" }],
    });
    // The platform hands this caller the record whole — its
    // purpose included — so the values are served.
    const visible = await actions.getEventValues.run(editor, {
      cookie: COOKIE,
      subjectKind: "absence",
      subjectId: "abs-values",
    });
    expect(visible.map((v) => v.valueOptionId)).toEqual(["opt-remote"]);

    // The restricted shape is what the platform hands a reader who
    // may not see a leave's texts (PR #64): it has no purpose field,
    // and that reader is served no values.
    const record = fake.absences.get("abs-values") as Record<string, unknown>;
    const restricted = { ...record };
    delete restricted.purpose;
    fake.absences.set("abs-values", restricted);
    expect(
      await actions.getEventValues.run(editor, {
        cookie: COOKIE,
        subjectKind: "absence",
        subjectId: "abs-values",
      }),
    ).toEqual([]);
    fake.absences.set("abs-values", record);
  });

  it("serves no values for an event the platform will not show the caller", async () => {
    const editor = auth(A, "Editor");
    // ev-1 exists in the platform and carries values (created
    // earlier); a platform refusal to show it serves none of them.
    fake.failures.push({
      method: "GET",
      pathPrefix: EVENTS,
      status: 403,
      body: { error: "権限がありません" },
    });
    expect(
      await actions.getEventValues.run(editor, {
        cookie: COOKIE,
        subjectKind: "event",
        subjectId: "ev-1",
      }),
    ).toEqual([]);
    fake.failures = [];
    // A subject the platform does not have serves none either.
    expect(
      await actions.getEventValues.run(editor, {
        cookie: COOKIE,
        subjectKind: "event",
        subjectId: "ev-missing",
      }),
    ).toEqual([]);
    // And once the platform shows it again, the values are back.
    const values = await actions.getEventValues.run(editor, {
      cookie: COOKIE,
      subjectKind: "event",
      subjectId: "ev-1",
    });
    expect(values.map((v) => v.valueText)).toEqual(["教育委員会"]);
  });
});
