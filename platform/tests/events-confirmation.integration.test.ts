import type { Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadAuthConfig, type AuthConfig } from "../src/auth/config.js";
import { signSessionToken } from "../src/auth/tokens.js";
import { createAuthStore } from "../src/db/authStore.js";
import { createDb, type Db } from "../src/db/client.js";
import { createEventStore } from "../src/db/events.js";
import { runMigrations } from "../src/db/migrate.js";
import { memberships, persons, productRoles, schools } from "../src/db/schema.js";

// Event confirmation record tests (Issue #85): confirming an
// event records who confirmed it and when (confirmed_by /
// confirmed_at, DESIGN-AUTH-TENANCY 4.6 / 4.7), returning it to
// tentative clears the record, the database check refuses a row
// whose stamps disagree with its certainty, and the stamps never
// reach a non-staff response. The behaviour mirrors the absences'
// confirmation flow (Issue #25). Runs only when
// PLATFORM_DATABASE_URL is set (vitest.config).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const SECRET = "events-confirmation-test-secret";
const BASE = "/platform/api/v1/calendar/events";
const NOVEMBER = "from=2026-11-01&to=2026-11-30";

function dayEvent(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: "行事",
    kind: "event",
    kindLabel: null,
    datePrecision: "day",
    startsOn: "2026-11-10",
    endsOn: null,
    time: { kind: "all_day" },
    locationId: null,
    locationText: null,
    description: null,
    certainty: "tentative",
    visibility: "guardian",
    targets: [],
    impacts: [],
    assignees: [],
    ...overrides,
  };
}

describe.skipIf(!url)("event confirmation record", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let raw: ReturnType<typeof postgres>;
  let config: AuthConfig;
  let server: Server;
  let baseUrl: string;

  function sessionCookie(personId: string, schoolId: string): string {
    const token = signSessionToken(config, {
      personId,
      schoolId,
      email: `${personId}@example.jp`,
    });
    return `platform_session=${encodeURIComponent(token)}`;
  }

  const editorA = () => sessionCookie("person-editor", A);
  const otherEditorA = () => sessionCookie("person-editor-2", A);
  const viewerA = () => sessionCookie("person-viewer", A);

  interface ApiResult {
    status: number;
    json: Record<string, unknown> & { items?: Record<string, unknown>[] };
  }

  async function api(
    method: string,
    path: string,
    options: { cookie?: string; body?: unknown } = {},
  ): Promise<ApiResult> {
    const init: RequestInit = {
      method,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await fetch(`${baseUrl}${path}`, init);
    const json = (
      res.status === 204 ? {} : await res.json().catch(() => ({}))
    ) as ApiResult["json"];
    return { status: res.status, json };
  }

  beforeAll(async () => {
    const admin = postgres(url as string, { max: 1 });
    await admin.unsafe("drop schema public cascade");
    await admin.unsafe("create schema public");
    await admin.unsafe("drop schema if exists drizzle cascade");
    await admin.end();

    const created = createDb(url);
    db = created.db;
    queryClient = created.queryClient;
    raw = postgres(url as string, { max: 1 });
    await runMigrations(db);

    await db.insert(schools).values([{ schoolId: A, slug: "school-a", name: "A校" }]);
    await db.insert(persons).values([
      { id: "person-editor", email: "editor@example.jp", displayName: "編集者" },
      { id: "person-editor-2", email: "editor2@example.jp", displayName: "編集者2" },
      { id: "person-viewer", email: "viewer@example.jp", displayName: "閲覧者" },
    ]);
    await db.insert(memberships).values([
      { id: "membership-editor-a", schoolId: A, personId: "person-editor", status: "approved" },
      { id: "membership-editor2-a", schoolId: A, personId: "person-editor-2", status: "approved" },
      { id: "membership-viewer-a", schoolId: A, personId: "person-viewer", status: "approved" },
    ]);
    await db.insert(productRoles).values([
      {
        id: "role-editor-schedule",
        schoolId: A,
        membershipId: "membership-editor-a",
        product: "schedule",
        role: "Editor",
      },
      {
        id: "role-editor2-timetable",
        schoolId: A,
        membershipId: "membership-editor2-a",
        product: "timetable",
        role: "Editor",
      },
      {
        id: "role-viewer-schedule",
        schoolId: A,
        membershipId: "membership-viewer-a",
        product: "schedule",
        role: "Viewer",
      },
    ]);

    config = loadAuthConfig({ JWT_SECRET: SECRET });
    const app = createApp({
      events: { config, authStore: createAuthStore(db), eventStore: createEventStore(db) },
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.close();
    await raw.end();
    await queryClient.end();
  });

  it("confirming stamps the confirmer and the moment; returning to tentative clears them", async () => {
    const created = await api("POST", BASE, { cookie: editorA(), body: dayEvent("ev-confirm") });
    expect(created.status).toBe(201);
    expect(created.json["certainty"]).toBe("tentative");
    expect(created.json["confirmedBy"]).toBeNull();
    expect(created.json["confirmedAt"]).toBeNull();

    // A Viewer may not confirm (the confirm is a writer's act).
    const refused = await api("POST", `${BASE}/ev-confirm/confirm`, {
      cookie: viewerA(),
      body: { revision: 1 },
    });
    expect(refused.status).toBe(403);

    const before = Date.now();
    const confirmed = await api("POST", `${BASE}/ev-confirm/confirm`, {
      cookie: otherEditorA(),
      body: { revision: 1 },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json["certainty"]).toBe("confirmed");
    expect(confirmed.json["confirmedBy"]).toBe("person-editor-2");
    const confirmedAt = confirmed.json["confirmedAt"];
    expect(typeof confirmedAt).toBe("string");
    const at = Date.parse(confirmedAt as string);
    expect(at).toBeGreaterThanOrEqual(before - 5000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5000);
    expect(confirmed.json["revision"]).toBe(2);

    // Confirming again returns the record as it stands: the
    // original confirmer and moment stay, and no revision is spent.
    const again = await api("POST", `${BASE}/ev-confirm/confirm`, {
      cookie: editorA(),
      body: { revision: 2 },
    });
    expect(again.status).toBe(200);
    expect(again.json["confirmedBy"]).toBe("person-editor-2");
    expect(again.json["confirmedAt"]).toBe(confirmedAt);
    expect(again.json["revision"]).toBe(2);

    // A stale revision is the platform's 409, as with any write.
    const stale = await api("POST", `${BASE}/ev-confirm/confirm`, {
      cookie: editorA(),
      body: { revision: 1 },
    });
    expect(stale.status).toBe(409);

    // Saving it back as tentative clears the record.
    const back = await api("PUT", `${BASE}/ev-confirm`, {
      cookie: editorA(),
      body: { ...dayEvent("ev-confirm"), revision: 2 },
    });
    expect(back.status).toBe(200);
    expect(back.json["certainty"]).toBe("tentative");
    expect(back.json["confirmedBy"]).toBeNull();
    expect(back.json["confirmedAt"]).toBeNull();

    const rows = await raw`
      select confirmed_by, confirmed_at from events where school_id = ${A} and id = 'ev-confirm'
    `;
    expect(rows[0]).toMatchObject({ confirmed_by: null, confirmed_at: null });
  });

  it("a save keeps the stamps consistent: created confirmed, kept by another editor, stamped on becoming confirmed", async () => {
    // Created already confirmed: the creator is the confirmer.
    const created = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-born-confirmed", { certainty: "confirmed" }),
    });
    expect(created.status).toBe(201);
    expect(created.json["confirmedBy"]).toBe("person-editor");
    expect(typeof created.json["confirmedAt"]).toBe("string");
    const bornAt = created.json["confirmedAt"];

    // Another editor's edit that stays confirmed keeps the
    // original confirmer and moment.
    const edited = await api("PUT", `${BASE}/ev-born-confirmed`, {
      cookie: otherEditorA(),
      body: {
        ...dayEvent("ev-born-confirmed", { certainty: "confirmed", title: "行事（変更）" }),
        revision: 1,
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.json["confirmedBy"]).toBe("person-editor");
    expect(edited.json["confirmedAt"]).toBe(bornAt);

    // A tentative event saved as confirmed is stamped with the
    // saver, not with its creator.
    const tentative = await api("POST", BASE, {
      cookie: editorA(),
      body: dayEvent("ev-late-confirm"),
    });
    expect(tentative.status).toBe(201);
    const saved = await api("PUT", `${BASE}/ev-late-confirm`, {
      cookie: otherEditorA(),
      body: { ...dayEvent("ev-late-confirm", { certainty: "confirmed" }), revision: 1 },
    });
    expect(saved.status).toBe(200);
    expect(saved.json["confirmedBy"]).toBe("person-editor-2");
    expect(typeof saved.json["confirmedAt"]).toBe("string");
  });

  it("the database check refuses rows whose stamps disagree with the certainty", async () => {
    const insert = (id: string, certainty: string, by: string | null, at: string | null) =>
      raw`
        insert into events (
          school_id, id, title, kind, date_precision, starts_on, certainty,
          visibility, revision, created_by, confirmed_by, confirmed_at,
          updated_by, updated_via
        ) values (
          ${A}, ${id}, '行事', 'event', 'day', '2026-11-10', ${certainty},
          'staff_only', 1, 'person-editor', ${by}, ${at},
          'person-editor', 'platform'
        )
      `;
    const stamp = "2026-11-01T09:00:00.000Z";
    // Tentative, yet carrying a record.
    await expect(insert("ev-bad-1", "tentative", "person-editor", stamp)).rejects.toThrow(
      /events_confirmation_stamps/,
    );
    await expect(insert("ev-bad-2", "tentative", null, stamp)).rejects.toThrow(
      /events_confirmation_stamps/,
    );
    // Confirmed, yet missing the record (or half of it).
    await expect(insert("ev-bad-3", "confirmed", null, null)).rejects.toThrow(
      /events_confirmation_stamps/,
    );
    await expect(insert("ev-bad-4", "confirmed", "person-editor", null)).rejects.toThrow(
      /events_confirmation_stamps/,
    );
    await expect(insert("ev-bad-5", "confirmed", null, stamp)).rejects.toThrow(
      /events_confirmation_stamps/,
    );
    // The two consistent shapes go in.
    await insert("ev-good-1", "tentative", null, null);
    await insert("ev-good-2", "confirmed", "person-editor", stamp);
  });

  it("a non-staff response carries neither stamp, a staff response carries both", async () => {
    const created = await api("POST", BASE, {
      cookie: editorA(),
      // Visibility "public" so every non-staff audience may read
      // it and the shaping — not the visibility — is what is tested.
      body: dayEvent("ev-audience", { certainty: "confirmed", visibility: "public" }),
    });
    expect(created.status).toBe(201);

    const staff = await api("GET", `${BASE}/ev-audience`, { cookie: viewerA() });
    expect(staff.status).toBe(200);
    expect(staff.json["confirmedBy"]).toBe("person-editor");
    expect(typeof staff.json["confirmedAt"]).toBe("string");

    for (const audience of ["guardian", "student", "public"]) {
      const read = await api("GET", `${BASE}/ev-audience?audience=${audience}`, {
        cookie: viewerA(),
      });
      expect(read.status).toBe(200);
      expect(read.json).not.toHaveProperty("confirmedBy");
      expect(read.json).not.toHaveProperty("confirmedAt");
    }

    const listed = await api("GET", `${BASE}?${NOVEMBER}&audience=guardian`, {
      cookie: viewerA(),
    });
    expect(listed.status).toBe(200);
    const item = (listed.json.items ?? []).find((i) => i["id"] === "ev-audience");
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty("confirmedBy");
    expect(item).not.toHaveProperty("confirmedAt");
  });
});
