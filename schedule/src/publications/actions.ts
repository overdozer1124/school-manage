import { randomUUID } from "node:crypto";
import { defineActions } from "@school-manage/platform-client";
import { addDays } from "@school-manage/calendar-types";
import * as definitionsStore from "../db/definitions.js";
import * as dutiesStore from "../db/duties.js";
import * as templatesStore from "../db/kindTemplates.js";
import * as publicationsStore from "../db/publications.js";
import * as viewsStore from "../db/views.js";
import { tenantDb } from "../db/tenant.js";
import type { DutyPlatformSource } from "../duties/platformSource.js";
import { scheduleAction } from "../permissions.js";
import { unwrapPlatformResult, type PlatformApiClient } from "../platformClient.js";
import { computeRange } from "../range/actions.js";
import { diffSnapshots } from "./diff.js";
import { renderPublicationDocument, type PrintContext } from "./render.js";
import { buildPublicationSnapshot } from "./snapshot.js";
import {
  cancelPublicationInputSchema,
  createPublicationInputSchema,
  getPublicationDiffInputSchema,
  getPublicationInputSchema,
  getPublicationsInputSchema,
  resolvePrintSettings,
  updatePublicationInputSchema,
} from "./types.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

const ME_PATH = "/platform/api/v1/auth/me";
const MASTERS_PATH = "/platform/api/v1/masters";
const SUBDIVISIONS_PATH = "/platform/api/v1/calendar/absence-subdivisions";

function itemsOf(body: unknown): Record<string, unknown>[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

/** The last day of a "YYYY-MM" month. */
function monthEndOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const next = mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

/**
 * The publication actions (Issue #40), declared with the
 * permissions of DESIGN-AUTH-TENANCY 4.4: issuing is `publish`
 * (Admin and Editor), reading the version list and an issued
 * document is view.read.
 *
 * createPublication renders the document on the server, from the
 * same computeRange bundle the screen draws (so the paper and
 * the screen cannot drift apart), and stores it with the version
 * record in one write. The document itself is never rewritten,
 * so the document a reader gets back is the document that was
 * issued, byte for byte, however the underlying data has changed
 * since (DESIGN schedule 9.1, DESIGN-AUTH-TENANCY 4.5). To hand
 * out a corrected table, issue a new version.
 *
 * Issue #48 adds the record keeping around the document, under
 * the same permissions (edits and cancellation are `publish`,
 * the diff is view.read): the structured snapshot is stored
 * with the document so getPublicationDiff can name the days
 * and items that changed since the previous version; the
 * label and note may be corrected afterwards (never on a
 * cancelled version — a withdrawn version's record stands as
 * it was left); and a version may be cancelled, which stamps
 * the record and keeps it in the history.
 */
export function createPublicationActions(
  db: Db,
  platformClient: PlatformApiClient,
  dutyPlatform?: DutyPlatformSource,
) {
  async function platformItems(path: string, cookie: string): Promise<Record<string, unknown>[]> {
    return itemsOf(unwrapPlatformResult(await platformClient.getJson(path, cookie)));
  }

  return defineActions({
    createPublication: scheduleAction("publish", async ({ auth, request }) => {
      const input = createPublicationInputSchema.parse(request);
      const view = (await viewsStore.getViews(db, auth.schoolId)).find(
        (v) => v.id === input.viewId,
      );
      if (!view) {
        throw new Error(`view definition not found: ${input.viewId}`);
      }
      const range = await computeRange(db, platformClient, dutyPlatform, auth.schoolId, {
        from: `${input.targetMonth}-01`,
        to: monthEndOf(input.targetMonth),
        viewId: view.id,
        cookie: input.cookie,
      });
      const [
        definitionSet,
        kindTemplates,
        dutyDefinitions,
        me,
        staff,
        grades,
        dayPatterns,
        subdivisions,
      ] = await Promise.all([
        definitionsStore.getDefinitionSet(db, auth.schoolId),
        templatesStore.getKindTemplates(db, auth.schoolId),
        dutiesStore.getDutyDefinitions(db, auth.schoolId),
        unwrapPlatformResult(await platformClient.getJson(ME_PATH, input.cookie)),
        platformItems(`${MASTERS_PATH}/staff`, input.cookie),
        platformItems(`${MASTERS_PATH}/grades`, input.cookie),
        platformItems(`${MASTERS_PATH}/day-patterns`, input.cookie),
        platformItems(SUBDIVISIONS_PATH, input.cookie),
      ]);
      const school = (me as { school?: { name?: unknown } } | null)?.school;
      const context: PrintContext = {
        itemDefinitions: definitionSet.itemDefinitions,
        targetGroups: definitionSet.targetGroups,
        kindTemplates,
        dutyDefinitions,
        absenceSubdivisions: subdivisions,
        staff,
        grades,
        dayPatterns,
      };
      const printSettings = resolvePrintSettings(view.printSettings, input.printSettings);
      const publishedAt = new Date();
      const renderInput = {
        schoolName: typeof school?.name === "string" ? school.name : null,
        viewName: view.name,
        targetMonth: input.targetMonth,
        versionLabel: input.versionLabel,
        publishedAt,
        range,
        printSettings,
        context,
      };
      const documentHtml = renderPublicationDocument(renderInput);
      // The structured snapshot of the same bundle (Issue #48):
      // the day-by-day cell texts a later version diffs against.
      const snapshotJson = buildPublicationSnapshot(renderInput);
      const row = await publicationsStore.insertPublication(db, auth.schoolId, {
        id: randomUUID(),
        viewDefinitionId: view.id,
        targetMonth: input.targetMonth,
        versionLabel: input.versionLabel,
        publishedAt,
        publishedBy: auth.userId,
        snapshotNote: input.note ?? null,
        printSettings,
        documentFormat: "html",
        documentHtml,
        snapshotJson,
      });
      return publicationsStore.toPublicationMeta(row);
    }),

    getPublications: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getPublicationsInputSchema.parse(request ?? {});
      return publicationsStore.listPublications(db, auth.schoolId, input.viewId, input.targetMonth);
    }),

    getPublication: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getPublicationInputSchema.parse(request);
      const row = await publicationsStore.getPublication(db, auth.schoolId, input.id);
      if (!row) {
        throw new Error(`publication not found: ${input.id}`);
      }
      return row;
    }),

    updatePublication: scheduleAction("publish", async ({ auth, request }) => {
      const input = updatePublicationInputSchema.parse(request);
      const row = await publicationsStore.getPublication(db, auth.schoolId, input.id);
      if (!row) {
        throw new Error(`publication not found: ${input.id}`);
      }
      if (row.cancelledAt) {
        // A cancelled version's record stands as it was left
        // when it was withdrawn (Issue #48).
        throw new Error("取り消した版のラベルとメモは編集できません");
      }
      const patch: { versionLabel?: string; snapshotNote?: string | null } = {};
      if (input.versionLabel !== undefined) patch.versionLabel = input.versionLabel;
      if (input.note !== undefined) patch.snapshotNote = input.note;
      const meta = await publicationsStore.updatePublicationMeta(
        db,
        auth.schoolId,
        input.id,
        patch,
      );
      if (!meta) {
        throw new Error(`publication not found: ${input.id}`);
      }
      return meta;
    }),

    cancelPublication: scheduleAction("publish", async ({ auth, request }) => {
      const input = cancelPublicationInputSchema.parse(request);
      const row = await publicationsStore.getPublication(db, auth.schoolId, input.id);
      if (!row) {
        throw new Error(`publication not found: ${input.id}`);
      }
      if (row.cancelledAt) {
        throw new Error("この版はすでに取り消されています");
      }
      const meta = await publicationsStore.cancelPublication(
        db,
        auth.schoolId,
        input.id,
        new Date(),
      );
      if (!meta) {
        throw new Error("この版はすでに取り消されています");
      }
      return meta;
    }),

    getPublicationDiff: scheduleAction("view.read", async ({ auth, request }) => {
      const input = getPublicationDiffInputSchema.parse(request);
      const row = await publicationsStore.getPublication(db, auth.schoolId, input.id);
      if (!row) {
        throw new Error(`publication not found: ${input.id}`);
      }
      const previous = await publicationsStore.getPreviousPublication(db, auth.schoolId, row);
      if (!previous) {
        // The first version of its view and month: nothing
        // before it, so nothing changed from anything.
        return { comparable: true, fromId: null, toId: row.id, changes: [] };
      }
      if (!row.snapshotJson || !previous.snapshotJson) {
        // Either side predates the structured snapshot (Issue
        // #48): the documents exist, but there is nothing
        // structured to compare.
        return { comparable: false, fromId: previous.id, toId: row.id };
      }
      return {
        comparable: true,
        fromId: previous.id,
        toId: row.id,
        changes: diffSnapshots(previous.snapshotJson, row.snapshotJson),
      };
    }),
  });
}
