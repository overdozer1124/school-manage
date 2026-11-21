import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { ChangeEvent } from "@school-manage/calendar-types";
import type { Db } from "./client.js";
import { toChangeEvent } from "./changes.js";
import {
  outbox,
  productEntitlements,
  webhookDeliveries,
  type Product,
  type WebhookDeliveryRow,
} from "./schema.js";

/**
 * The webhook delivery state machine (Issue #106, DESIGN-INTEGRATION
 * 7.1). The dispatcher (src/webhooks/deliver.ts) owns the HTTP send;
 * this store owns the position: what has been delivered to each
 * product, what is retried when, and which changes a product may see
 * at all (only schools whose entitlement for it is in force).
 *
 * One delivery run is one transaction holding the destination's
 * state row under SELECT … FOR UPDATE, so two platform processes
 * can never send to the same destination at the same time; a second
 * process waits, then finds the position already advanced (or the
 * retry time pushed out) and does nothing. The send itself happens
 * inside the transaction: it is bounded by the dispatcher's request
 * timeout, and holding the row for that span is what makes the
 * position and the send atomic — a crash mid-send rolls back, the
 * position stays, and the batch is sent again (receivers drop
 * duplicates by (schoolId, entityId, revision), 7.1).
 */

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface WebhookDeliveryPolicy {
  /** Changes considered per delivery run. Default 500. */
  batchLimit: number;
  /** Delay after the first failure, in seconds. Default 5. */
  backoffBaseSeconds: number;
  /** Longest delay between retries, in seconds. Default 900. */
  backoffCapSeconds: number;
}

export const DEFAULT_DELIVERY_POLICY: WebhookDeliveryPolicy = {
  batchLimit: 500,
  backoffBaseSeconds: 5,
  backoffCapSeconds: 900,
};

export type DeliveryOutcome =
  /** Nothing is waiting past the delivered position. */
  | { kind: "idle" }
  /** A failed delivery is still waiting out its backoff. */
  | { kind: "backoff"; nextAttemptAt: Date }
  /** Waiting changes existed, but none were for entitled schools:
   *  the position moved past them without a send. */
  | { kind: "advanced"; throughSeq: number }
  /** The batch was accepted (2xx); the position moved past it.
   *  previousFailureCount is the failure count this delivery
   *  cleared, so the caller can log a recovery when a destination
   *  that had been failing delivers again. */
  | { kind: "delivered"; throughSeq: number; sentCount: number; previousFailureCount: number }
  /** The send failed; the position stayed and a retry is scheduled.
   *  failureCount is the count after this failure, so the caller
   *  can log exactly once when failures begin (the 0 → 1 step). */
  | { kind: "failed"; error: string; failureCount: number; nextAttemptAt: Date };

/**
 * Sends one batch. Returns null when the receiver accepted it
 * (HTTP 2xx), or a short failure summary otherwise — the summary is
 * stored in webhook_deliveries.last_error, so it must never carry a
 * secret, a request body or a response body.
 */
export type SendBatch = (events: ChangeEvent[]) => Promise<string | null>;

export interface WebhookStore {
  /**
   * Creates the destination's state row if it has none, starting at
   * the outbox's current latest seq: a destination configured for
   * the first time is never sent the changes from before it existed.
   */
  ensureDestination(product: Product): Promise<void>;
  /** The destination's delivery state, or undefined before it exists. */
  getState(product: Product): Promise<WebhookDeliveryRow | undefined>;
  /**
   * One delivery run for a destination: reads what is waiting past
   * its position, filters it to entitled schools, sends what remains
   * through `send`, and records the outcome. See the module comment
   * for the locking and atomicity contract.
   */
  runDelivery(product: Product, send: SendBatch, now?: Date): Promise<DeliveryOutcome>;
}

/** The date in the schools' timezone, as the entitlement periods use. */
function todayString(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = new Map(parts.map((p) => [p.type, p.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

async function insertDestinationIfAbsent(tx: Transaction, product: Product): Promise<void> {
  // The starting position is read in the same statement that creates
  // the row, so a change committed between a separate read and
  // insert could not slip in behind the new destination's back.
  await tx.execute(sql`
    insert into webhook_deliveries (product, last_delivered_seq)
    select ${product}, coalesce(max(seq), 0) from outbox
    on conflict (product) do nothing
  `);
}

/** The subset of `schoolIds` whose entitlement for `product` is in force on `today`. */
async function entitledSchoolIds(
  tx: Transaction,
  product: Product,
  schoolIds: string[],
  today: string,
): Promise<Set<string>> {
  if (schoolIds.length === 0) return new Set();
  const rows = await tx
    .select({ schoolId: productEntitlements.schoolId })
    .from(productEntitlements)
    .where(
      and(
        eq(productEntitlements.product, product),
        eq(productEntitlements.status, "active"),
        inArray(productEntitlements.schoolId, schoolIds),
        lte(productEntitlements.startsOn, today),
        or(isNull(productEntitlements.endsOn), gte(productEntitlements.endsOn, today)),
      ),
    );
  return new Set(rows.map((row) => row.schoolId));
}

export function createWebhookStore(
  db: Db,
  policy: WebhookDeliveryPolicy = DEFAULT_DELIVERY_POLICY,
): WebhookStore {
  return {
    async ensureDestination(product) {
      await db.transaction((tx) => insertDestinationIfAbsent(tx, product));
    },

    async getState(product) {
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.product, product))
        .limit(1);
      return rows[0];
    },

    async runDelivery(product, send, now = new Date()) {
      return db.transaction(async (tx) => {
        await insertDestinationIfAbsent(tx, product);
        const locked = await tx
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.product, product))
          .for("update");
        const state = locked[0] as WebhookDeliveryRow;

        if (state.nextAttemptAt && state.nextAttemptAt.getTime() > now.getTime()) {
          return { kind: "backoff", nextAttemptAt: state.nextAttemptAt } as DeliveryOutcome;
        }

        const pending = await tx
          .select()
          .from(outbox)
          .where(gt(outbox.seq, state.lastDeliveredSeq))
          .orderBy(asc(outbox.seq))
          .limit(policy.batchLimit);
        if (pending.length === 0) return { kind: "idle" } as DeliveryOutcome;
        const throughSeq = (pending[pending.length - 1] as (typeof pending)[number]).seq;

        const entitled = await entitledSchoolIds(
          tx,
          product,
          [...new Set(pending.map((row) => row.schoolId))],
          todayString(now),
        );
        const deliverable = pending.filter((row) => entitled.has(row.schoolId));

        if (deliverable.length === 0) {
          // Nothing here is this product's to see; the position
          // moves past it so it is not reconsidered on every poll.
          await tx
            .update(webhookDeliveries)
            .set({
              lastDeliveredSeq: throughSeq,
              failureCount: 0,
              nextAttemptAt: null,
              lastError: null,
              updatedAt: now,
            })
            .where(eq(webhookDeliveries.product, product));
          return { kind: "advanced", throughSeq } as DeliveryOutcome;
        }

        const error = await send(deliverable.map(toChangeEvent));
        if (error === null) {
          await tx
            .update(webhookDeliveries)
            .set({
              lastDeliveredSeq: throughSeq,
              failureCount: 0,
              nextAttemptAt: null,
              lastError: null,
              updatedAt: now,
            })
            .where(eq(webhookDeliveries.product, product));
          return {
            kind: "delivered",
            throughSeq,
            sentCount: deliverable.length,
            previousFailureCount: state.failureCount,
          } as DeliveryOutcome;
        }

        const failureCount = state.failureCount + 1;
        const delaySeconds = Math.min(
          policy.backoffBaseSeconds * 2 ** (failureCount - 1),
          policy.backoffCapSeconds,
        );
        const nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
        await tx
          .update(webhookDeliveries)
          .set({
            failureCount,
            nextAttemptAt,
            // The summary is the dispatcher's own wording (an HTTP
            // status or a fetch error's name); the slice is a final
            // guard against an over-long value reaching the record.
            lastError: error.slice(0, 200),
            updatedAt: now,
          })
          .where(eq(webhookDeliveries.product, product));
        return { kind: "failed", error, failureCount, nextAttemptAt } as DeliveryOutcome;
      });
    },
  };
}
