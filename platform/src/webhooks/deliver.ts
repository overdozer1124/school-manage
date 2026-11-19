import {
  createWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "@school-manage/platform-client";
import type { ChangeEvent } from "@school-manage/calendar-types";
import type { WebhookStore } from "../db/webhooks.js";
import type { Product } from "../db/schema.js";

/**
 * Webhook delivery (Issue #106, DESIGN-INTEGRATION 7-4 / 7.1): the
 * platform polls its change outbox and posts each product the
 * changes for the schools that product serves, signed with the
 * destination's secret. The delivery state machine (position,
 * entitlement filtering, retry backoff) lives in the store
 * (src/db/webhooks.ts); this module owns the configuration, the
 * HTTP send and the poll loop.
 *
 * A destination is one product's receiver, configured entirely from
 * the environment: WEBHOOK_SCHEDULE_URL + WEBHOOK_SCHEDULE_SECRET,
 * WEBHOOK_TIMETABLE_URL + WEBHOOK_TIMETABLE_SECRET. An app with
 * either value missing gets nothing, and with no destination
 * configured the platform behaves exactly as before — the entry
 * point does not even start the dispatcher. Secrets are used only
 * as HMAC keys here: they are never logged, and the failure
 * summaries handed to the store carry an HTTP status or a fetch
 * error's name, never a message that could quote a header.
 */
export interface WebhookDestination {
  product: Product;
  url: string;
  secret: string;
}

const DESTINATION_ENV: ReadonlyArray<{ product: Product; prefix: string }> = [
  { product: "schedule", prefix: "WEBHOOK_SCHEDULE" },
  { product: "timetable", prefix: "WEBHOOK_TIMETABLE" },
];

export function loadWebhookDestinations(
  env: NodeJS.ProcessEnv = process.env,
): WebhookDestination[] {
  const destinations: WebhookDestination[] = [];
  for (const { product, prefix } of DESTINATION_ENV) {
    const url = env[`${prefix}_URL`] || undefined;
    const secret = env[`${prefix}_SECRET`] || undefined;
    if (url && secret) destinations.push({ product, url, secret });
  }
  return destinations;
}

export interface WebhookDispatcherDeps {
  store: WebhookStore;
  destinations: WebhookDestination[];
  /** Tests inject a fake; the default is the global fetch. */
  fetchImpl?: typeof fetch;
  /** One send is given up on after this long. Default 10 seconds. */
  timeoutMs?: number;
  /** How often start() polls the outbox. Default 5 seconds. */
  intervalMs?: number;
  /** Clock for the delivery runs. Tests inject one. */
  now?: () => Date;
}

export interface WebhookDispatcher {
  /**
   * One poll: a delivery run for every configured destination.
   * Exported apart from start() so tests drive delivery
   * deterministically instead of waiting on the timer.
   */
  deliverPending(): Promise<void>;
  /** Polls on the interval until the returned stop function is called. */
  start(): () => void;
}

export function createWebhookDispatcher(deps: WebhookDispatcherDeps): WebhookDispatcher {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const intervalMs = deps.intervalMs ?? 5_000;
  const now = deps.now ?? (() => new Date());

  /**
   * Posts one batch to a destination. Returns null on a 2xx answer
   * and a short summary otherwise; see SendBatch in db/webhooks.ts
   * for why the summary is only ever a status or an error name.
   */
  async function sendBatch(destination: WebhookDestination, events: ChangeEvent[]) {
    const rawBody = JSON.stringify({ events });
    const timestampSeconds = Math.floor(now().getTime() / 1000);
    let res: Response;
    try {
      res = await fetchImpl(destination.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WEBHOOK_TIMESTAMP_HEADER]: String(timestampSeconds),
          [WEBHOOK_SIGNATURE_HEADER]: createWebhookSignature(
            destination.secret,
            timestampSeconds,
            rawBody,
          ),
        },
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return error instanceof Error ? error.name : "fetch failed";
    }
    // Drain the body so the connection closes (or is reused)
    // cleanly; its content is never read, logged or stored.
    await res.text().catch(() => undefined);
    return res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`;
  }

  async function deliverPending(): Promise<void> {
    for (const destination of deps.destinations) {
      try {
        await deps.store.runDelivery(
          destination.product,
          (events) => sendBatch(destination, events),
          now(),
        );
      } catch {
        // The store records ordinary send failures itself; reaching
        // here means the run itself failed (a database error, most
        // likely). One destination's trouble must not stop the
        // others, and the next poll retries from the same position.
        console.error(`webhook delivery run failed for ${destination.product}`);
      }
    }
  }

  function start(): () => void {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      void deliverPending().finally(() => {
        running = false;
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  return { deliverPending, start };
}
