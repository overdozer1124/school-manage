import { defineActions } from "@school-manage/platform-client";
import { platformAction } from "../permissions.js";
import { unwrapPlatformResult, type PlatformApiClient } from "../platformClient.js";
import {
  MASTER_SEGMENTS,
  createMasterInputSchema,
  deleteMasterInputSchema,
  getMastersInputSchema,
  updateMasterInputSchema,
  type MasterKind,
} from "./types.js";

const MASTERS_PATH = "/platform/api/v1/masters";

/** The master kinds, in the order the settings screen lists them. */
const KINDS = Object.keys(MASTER_SEGMENTS) as MasterKind[];

/**
 * The shared-master relay (Issue #39): the settings screen edits
 * the platform's shared masters — staff, grades, classes,
 * special-needs classes and day patterns (DESIGN schedule 5.3,
 * DESIGN-INTEGRATION 2.4) — through this server, as Issue #39's
 * scope prescribes. The platform already exposes the full CRUD
 * (Issue #22) and judges every call itself: reads need a current
 * membership, writes need Editor or more in either product
 * （連携5). So these actions are declared with platformAction,
 * like the event relay (Issue #29): the recorded names are the
 * DESIGN-AUTH-TENANCY 4.4 permissions for the operation
 * (view.read to read, master.write to change), and the
 * platform's verdict — 401 / 403 / 409 — returns as-is instead
 * of a second, schedule-side judgment that could disagree.
 */
export function createMasterRelayActions(platformClient: PlatformApiClient) {
  async function relay(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    cookie: string,
    body?: unknown,
  ): Promise<unknown> {
    return unwrapPlatformResult(await platformClient.requestJson(method, path, cookie, body));
  }

  function itemsOf(body: unknown): Record<string, unknown>[] {
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return [];
    return items.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }

  return defineActions({
    /** Every master kind in one read, for the settings screen. */
    getMasters: platformAction("view.read", async ({ request }) => {
      const input = getMastersInputSchema.parse(request);
      const lists = await Promise.all(
        KINDS.map((kind) => relay("GET", `${MASTERS_PATH}/${MASTER_SEGMENTS[kind]}`, input.cookie)),
      );
      return Object.fromEntries(KINDS.map((kind, i) => [kind, itemsOf(lists[i])]));
    }),

    createMaster: platformAction("master.write", async ({ request }) => {
      const input = createMasterInputSchema.parse(request);
      return relay(
        "POST",
        `${MASTERS_PATH}/${MASTER_SEGMENTS[input.kind]}`,
        input.cookie,
        input.record,
      );
    }),

    updateMaster: platformAction("master.write", async ({ request }) => {
      const input = updateMasterInputSchema.parse(request);
      if (input.record.id !== input.id) {
        throw new Error(`master record id does not match: ${input.record.id} != ${input.id}`);
      }
      return relay(
        "PUT",
        `${MASTERS_PATH}/${MASTER_SEGMENTS[input.kind]}/${encodeURIComponent(input.id)}`,
        input.cookie,
        input.record,
      );
    }),

    deleteMaster: platformAction("master.write", async ({ request }) => {
      const input = deleteMasterInputSchema.parse(request);
      await relay(
        "DELETE",
        `${MASTERS_PATH}/${MASTER_SEGMENTS[input.kind]}/${encodeURIComponent(input.id)}`,
        input.cookie,
        { revision: input.revision },
      );
      return { deleted: true };
    }),
  });
}
