import { defineActions } from "@school-manage/platform-client";
import { scheduleAction } from "../permissions.js";
import {
  PlatformRelayError,
  unwrapPlatformResult,
  type PlatformApiClient,
  type PlatformApiResult,
} from "../platformClient.js";
import {
  applyDefaultSubdivisionsInputSchema,
  createSubdivisionInputSchema,
  deleteSubdivisionInputSchema,
  getSubdivisionsInputSchema,
  updateSubdivisionInputSchema,
} from "./types.js";

const SUBDIVISIONS_PATH = "/platform/api/v1/calendar/absence-subdivisions";

/** The refusal wordings this relay owns (Issue #84). The platform
 *  answers a duplicate key and a still-used subdivision with one
 *  shared 409 sentence ("その操作は現在の状態と競合します") —
 *  accurate, but it does not tell the admin which of the two
 *  happened or what to do about it, so the delete and the writes
 *  translate a bare 409 (one with no `latest` record attached:
 *  a revision conflict always carries the current record, and
 *  that answer passes through untouched) into the specific
 *  reason, in the platform's own refusal shape so the settings
 *  screen shows it as-is. */
const IN_USE_MESSAGE = "この分類は不在で使われているため削除できません";
const DUPLICATE_MESSAGE = "同じ種類で同じキーの分類がすでにあります";

/**
 * The absence-subdivision relay (Issue #84): the settings screen
 * maintains the school's leave classifications （年休・特休 and
 * their kin under the other absence kinds) through this server.
 * The definitions live in the platform (Issue #25), which exposes
 * the full CRUD plus apply-defaults and judges every call itself.
 *
 * The permission is school.admin, checked here — deliberately
 * NOT the master relay's platformAction pattern (Issue #39).
 * There the platform's own judgment IS the rule （連携5: Editor
 * or more in either product), so a second schedule-side check
 * could only disagree. Here the design's role table puts the
 * subdivisions with the Admin (DESIGN-AUTH-TENANCY 4.5: their
 * reading is Admin's), and the platform's writer check alone
 * would let an Editor through; the Issue fixes the relay at
 * Admin only, so the gate is scheduleAction's, and the platform
 * still judges the call itself behind it (its 401 / 403 / 409
 * verdicts return as-is, apart from the wording translation
 * above).
 */
export function createSubdivisionRelayActions(platformClient: PlatformApiClient) {
  async function relay(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    cookie: string,
    body?: unknown,
    conflictMessage?: string,
  ): Promise<unknown> {
    const result: PlatformApiResult = await platformClient.requestJson(method, path, cookie, body);
    if (result.status === 409 && conflictMessage) {
      const bodyObject = result.body as { latest?: unknown } | null;
      if (!bodyObject || typeof bodyObject !== "object" || !("latest" in bodyObject)) {
        throw new PlatformRelayError({ status: 409, body: { error: conflictMessage } });
      }
    }
    return unwrapPlatformResult(result);
  }

  return defineActions({
    getSubdivisions: scheduleAction("school.admin", async ({ request }) => {
      const input = getSubdivisionsInputSchema.parse(request);
      return relay("GET", SUBDIVISIONS_PATH, input.cookie);
    }),

    createSubdivision: scheduleAction("school.admin", async ({ request }) => {
      const input = createSubdivisionInputSchema.parse(request);
      return relay("POST", SUBDIVISIONS_PATH, input.cookie, input.record, DUPLICATE_MESSAGE);
    }),

    updateSubdivision: scheduleAction("school.admin", async ({ request }) => {
      const input = updateSubdivisionInputSchema.parse(request);
      if (input.record.id !== input.id) {
        throw new Error(`subdivision record id does not match: ${input.record.id} != ${input.id}`);
      }
      return relay(
        "PUT",
        `${SUBDIVISIONS_PATH}/${encodeURIComponent(input.id)}`,
        input.cookie,
        input.record,
        DUPLICATE_MESSAGE,
      );
    }),

    deleteSubdivision: scheduleAction("school.admin", async ({ request }) => {
      const input = deleteSubdivisionInputSchema.parse(request);
      await relay(
        "DELETE",
        `${SUBDIVISIONS_PATH}/${encodeURIComponent(input.id)}`,
        input.cookie,
        { revision: input.revision },
        IN_USE_MESSAGE,
      );
      return { deleted: true };
    }),

    /** Seeds the school's missing default leave subdivisions
     *  (the platform's list of DESIGN schedule 6.5); the answer
     *  is the platform's — the definitions it created. */
    applyDefaultSubdivisions: scheduleAction("school.admin", async ({ request }) => {
      const input = applyDefaultSubdivisionsInputSchema.parse(request);
      return relay("POST", `${SUBDIVISIONS_PATH}/apply-defaults`, input.cookie, {});
    }),
  });
}
