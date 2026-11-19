import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeEventSchema, type ChangeEvent } from "@school-manage/calendar-types";
import {
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "@school-manage/platform-client";
import { createApp } from "../src/app.js";
import { loadAuthConfig } from "../src/auth/config.js";
import { createAuthStore } from "../src/db/authStore.js";
import { appendChange, createChangeStore } from "../src/db/changes.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { productEntitlements, schools, webhookDeliveries } from "../src/db/schema.js";
import { createWebhookStore, type WebhookStore } from "../src/db/webhooks.js";
import { createWebhookDispatcher } from "../src/webhooks/deliver.js";
import { eq } from "drizzle-orm";

// Webhook tests (Issue #106): the platform's sending side against a
// local test receiver, and the server-to-server read of GET /changes.
// A is entitled to schedule only, B to timetable only (B's schedule
// entitlement is suspended, which must not count). Runs only when
// PLATFORM_DATABASE_URL is set (see vitest.config.ts).
const url = process.env.PLATFORM_DATABASE_URL;

const A = "school-a";
const B = "school-b";
const SCHEDULE_SECRET = "webhook-schedule-test-secret";
const TIMETABLE_SECRET = "webhook-timetable-test-secret";
const SCHEDULE_TOKEN = "changes-schedule-test-token";
const TIMETABLE_TOKEN = "changes-timetable-test-token";

const actor = { userId: "person-1", via: "platform" } as const;

interface ReceivedRequest {
  headers: IncomingHttpHeaders;
  rawBody: string;
}

interface TestReceiver {
  url: string;
  received: ReceivedRequest[];
  setStatus(status: number): void;
  close(): Promise<void>;
}

function startReceiver(): Promise<TestReceiver> {
  const received: ReceivedRequest[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      received.push({
        headers: req.headers,
        rawBody: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no receiver address");
      resolve({
        url: `http://127.0.0.1:${address.port}/integration/webhook`,
        received,
        setStatus(next: number) {
          status = next;
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

describe.skipIf(!url)("webhook delivery and service reads", () => {
  let db: Db;
  let queryClient: ReturnType<typeof postgres>;
  let store: WebhookStore;
  let scheduleReceiver: TestReceiver;
  let timetableReceiver: TestReceiver;
  let server: Server;
  let baseUrl: string;

  async function recordChange(schoolId: string, entityId: string): Promise<ChangeEvent> {
    return db.transaction((tx) =>
      appendChange(tx, {
        schoolId,
        kind: "day_pattern",
        entityId,
        revision: 1,
        op: "upsert",
        actor,
      }),
    );
  }

  function scheduleDispatcher() {
    return createWebhookDispatcher({
      store,
      destinations: [{ product: "schedule", url: scheduleReceiver.url, secret: SCHEDULE_SECRET }],
    });
  }

  async function getChangesWithToken(
    token: string | null,
    query = "",
  ): Promise<{ status: number; changes: ChangeEvent[] }> {
    const res = await fetch(`${baseUrl}/platform/api/v1/changes${query}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    const json = (await res.json().catch(() => ({}))) as { changes?: ChangeEvent[] };
    return { status: res.status, changes: json.changes ?? [] };
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
    await runMigrations(db);

    await db.insert(schools).values([
      { schoolId: A, slug: "school-a", name: "A校" },
      { schoolId: B, slug: "school-b", name: "B校" },
    ]);
    await db.insert(productEntitlements).values([
      {
        id: "ent-a-schedule",
        schoolId: A,
        product: "schedule",
        plan: "standard",
        status: "active",
        startsOn: "2020-01-01",
        endsOn: null,
      },
      {
        id: "ent-b-timetable",
        schoolId: B,
        product: "timetable",
        plan: "standard",
        status: "active",
        startsOn: "2020-01-01",
        endsOn: null,
      },
      {
        // Suspended is not in force: B's changes must never reach
        // the schedule receiver or the schedule service read.
        id: "ent-b-schedule-suspended",
        schoolId: B,
        product: "schedule",
        plan: "standard",
        status: "suspended",
        startsOn: "2020-01-01",
        endsOn: null,
      },
    ]);

    store = createWebhookStore(db);
    scheduleReceiver = await startReceiver();
    timetableReceiver = await startReceiver();

    const app = createApp({
      changes: {
        config: loadAuthConfig({ JWT_SECRET: "webhooks-test-secret" }),
        authStore: createAuthStore(db),
        changeStore: createChangeStore(db),
        serviceTokens: { schedule: SCHEDULE_TOKEN, timetable: TIMETABLE_TOKEN },
      },
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
    await scheduleReceiver.close();
    await timetableReceiver.close();
    await queryClient.end();
  });

  it("sends nothing and creates no state when no destination is configured", async () => {
    const dispatcher = createWebhookDispatcher({ store, destinations: [] });
    await dispatcher.deliverPending();
    expect(await db.select().from(webhookDeliveries)).toHaveLength(0);
    expect(scheduleReceiver.received).toHaveLength(0);
  });

  it("starts a new destination at the latest seq instead of backfilling", async () => {
    const before = await recordChange(A, "pattern-before-config");
    await scheduleDispatcher().deliverPending();
    expect(scheduleReceiver.received).toHaveLength(0);
    const state = await store.getState("schedule");
    expect(state?.lastDeliveredSeq).toBe(before.seq);

    const after = await recordChange(A, "pattern-after-config");
    await scheduleDispatcher().deliverPending();
    expect(scheduleReceiver.received).toHaveLength(1);
    const events = (
      JSON.parse(scheduleReceiver.received[0]?.rawBody ?? "{}") as { events: ChangeEvent[] }
    ).events;
    expect(events.map((e) => e.seq)).toEqual([after.seq]);
  });

  it("delivers a batch signed, in seq order, in the shared event shape", async () => {
    scheduleReceiver.received.length = 0;
    const first = await recordChange(A, "pattern-batch-1");
    const second = await recordChange(A, "pattern-batch-2");
    await scheduleDispatcher().deliverPending();

    expect(scheduleReceiver.received).toHaveLength(1);
    const request = scheduleReceiver.received[0] as ReceivedRequest;
    expect(request.headers["content-type"]).toContain("application/json");
    const events = (JSON.parse(request.rawBody) as { events: ChangeEvent[] }).events;
    expect(events.map((e) => e.seq)).toEqual([first.seq, second.seq]);
    for (const event of events) changeEventSchema.parse(event);

    expect(
      verifyWebhookSignature({
        secret: SCHEDULE_SECRET,
        rawBody: request.rawBody,
        timestamp: request.headers[WEBHOOK_TIMESTAMP_HEADER] as string,
        signature: request.headers[WEBHOOK_SIGNATURE_HEADER] as string,
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toBe(true);
    // The same delivery under the other product's secret must fail.
    expect(
      verifyWebhookSignature({
        secret: TIMETABLE_SECRET,
        rawBody: request.rawBody,
        timestamp: request.headers[WEBHOOK_TIMESTAMP_HEADER] as string,
        signature: request.headers[WEBHOOK_SIGNATURE_HEADER] as string,
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toBe(false);

    const state = await store.getState("schedule");
    expect(state?.lastDeliveredSeq).toBe(second.seq);
    expect(state?.failureCount).toBe(0);
  });

  it("keeps the position on failure and resumes from it after recovery", async () => {
    scheduleReceiver.received.length = 0;
    const stuck = await recordChange(A, "pattern-stuck");
    const before = await store.getState("schedule");

    scheduleReceiver.setStatus(500);
    await scheduleDispatcher().deliverPending();
    expect(scheduleReceiver.received).toHaveLength(1);
    const failed = await store.getState("schedule");
    expect(failed?.lastDeliveredSeq).toBe(before?.lastDeliveredSeq);
    expect(failed?.failureCount).toBe(1);
    expect(failed?.lastError).toBe("HTTP 500");
    expect(failed?.nextAttemptAt).not.toBeNull();
    expect((failed?.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now());

    // While the backoff runs, another poll sends nothing.
    await scheduleDispatcher().deliverPending();
    expect(scheduleReceiver.received).toHaveLength(1);

    // The receiver recovers; once the retry time is reached the
    // very same change is delivered — nothing was skipped.
    scheduleReceiver.setStatus(200);
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(webhookDeliveries.product, "schedule"));
    await scheduleDispatcher().deliverPending();
    expect(scheduleReceiver.received).toHaveLength(2);
    const events = (
      JSON.parse(scheduleReceiver.received[1]?.rawBody ?? "{}") as { events: ChangeEvent[] }
    ).events;
    expect(events.map((e) => e.seq)).toEqual([stuck.seq]);
    const recovered = await store.getState("schedule");
    expect(recovered?.lastDeliveredSeq).toBe(stuck.seq);
    expect(recovered?.failureCount).toBe(0);
    expect(recovered?.nextAttemptAt).toBeNull();
    expect(recovered?.lastError).toBeNull();
  });

  it("never sends a non-entitled school's changes, and they do not block later ones", async () => {
    scheduleReceiver.received.length = 0;
    const hidden = await recordChange(B, "pattern-b-hidden");
    const visible = await recordChange(A, "pattern-a-visible");
    await scheduleDispatcher().deliverPending();

    expect(scheduleReceiver.received).toHaveLength(1);
    const events = (
      JSON.parse(scheduleReceiver.received[0]?.rawBody ?? "{}") as { events: ChangeEvent[] }
    ).events;
    expect(events.map((e) => e.seq)).toEqual([visible.seq]);
    // The position moved past the hidden change too.
    expect((await store.getState("schedule"))?.lastDeliveredSeq).toBe(visible.seq);
    expect(hidden.seq).toBeLessThan(visible.seq);

    // A batch of only non-entitled changes advances without a send.
    const hiddenOnly = await recordChange(B, "pattern-b-hidden-only");
    await scheduleDispatcher().deliverPending();
    expect(scheduleReceiver.received).toHaveLength(1);
    expect((await store.getState("schedule"))?.lastDeliveredSeq).toBe(hiddenOnly.seq);
  });

  it("delivers to each product only its own schools, under its own secret", async () => {
    const dispatcher = createWebhookDispatcher({
      store,
      destinations: [
        { product: "timetable", url: timetableReceiver.url, secret: TIMETABLE_SECRET },
      ],
    });
    // The first run only establishes the destination (its position
    // starts at the then-latest seq, as the schedule test showed).
    await dispatcher.deliverPending();
    expect(timetableReceiver.received).toHaveLength(0);

    const forB = await recordChange(B, "pattern-b-for-timetable");
    await recordChange(A, "pattern-a-not-for-timetable");
    await dispatcher.deliverPending();

    expect(timetableReceiver.received).toHaveLength(1);
    const request = timetableReceiver.received[0] as ReceivedRequest;
    const events = (JSON.parse(request.rawBody) as { events: ChangeEvent[] }).events;
    expect(events.map((e) => e.seq)).toEqual([forB.seq]);
    expect(
      verifyWebhookSignature({
        secret: TIMETABLE_SECRET,
        rawBody: request.rawBody,
        timestamp: request.headers[WEBHOOK_TIMESTAMP_HEADER] as string,
        signature: request.headers[WEBHOOK_SIGNATURE_HEADER] as string,
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toBe(true);
  });

  it("serves a product's entitled schools' changes to its service credential", async () => {
    const scheduleRead = await getChangesWithToken(SCHEDULE_TOKEN);
    expect(scheduleRead.status).toBe(200);
    expect(scheduleRead.changes.length).toBeGreaterThan(0);
    expect(scheduleRead.changes.every((c) => c.schoolId === A)).toBe(true);
    const seqs = scheduleRead.changes.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    for (const change of scheduleRead.changes) changeEventSchema.parse(change);

    const timetableRead = await getChangesWithToken(TIMETABLE_TOKEN);
    expect(timetableRead.status).toBe(200);
    expect(timetableRead.changes.length).toBeGreaterThan(0);
    expect(timetableRead.changes.every((c) => c.schoolId === B)).toBe(true);

    const lastSeq = seqs[seqs.length - 1] as number;
    const after = await getChangesWithToken(SCHEDULE_TOKEN, `?after=${lastSeq}`);
    expect(after.status).toBe(200);
    expect(after.changes).toEqual([]);
  });

  it("refuses the service read without a credential or with a wrong one", async () => {
    expect((await getChangesWithToken(null)).status).toBe(401);
    expect((await getChangesWithToken("not-the-token")).status).toBe(401);
    // The other path's credential is not this path's: the public-read
    // token shape (a single shared token) must not open /changes.
    expect((await getChangesWithToken(SCHEDULE_SECRET)).status).toBe(401);
  });
});
