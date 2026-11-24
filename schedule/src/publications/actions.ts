import { randomUUID } from "node:crypto";
import { defineActions } from "@school-manage/platform-client";
import { addDays, weekStartOf } from "@school-manage/calendar-types";
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

/** The layouts a publication can issue (Issue #49): the rows
 *  tables (L1 month / L2 week), the two-column student table,
 *  the year table (L3) and the month calendar (L4). The week
 *  timeline (L5) and the transposed table are screen forms;
 *  issuing them is out of scope. */
const PUBLISHABLE_LAYOUTS = new Set([
  "month_rows",
  "week_rows",
  "two_column",
  "year_columns",
  "calendar_grid",
]);

/**
 * The span one publication covers, validated against the
 * view's layout (Issue #49): with no from/to named, the span
 * is the target month, as it was before spans were named. A
 * month-shaped layout (month_rows / two_column / calendar_grid)
 * issues exactly one calendar month and the target month must
 * be it; a week table issues a span of 7 or 14 days; a year
 * table issues its school year, April 1 to the following
 * March 31. A span that breaks its layout's rule is refused
 * with the rule it broke.
 */
function publicationSpanOf(
  layout: string,
  input: { targetMonth: string; from?: string | undefined; to?: string | undefined },
): { from: string; to: string } {
  if (!PUBLISHABLE_LAYOUTS.has(layout)) {
    throw new Error("このレイアウトは発行の対象外です（週タイムライン・転置表は画面表示のみです）");
  }
  const from = input.from ?? `${input.targetMonth}-01`;
  const to = input.to ?? monthEndOf(input.targetMonth);
  if (input.from !== undefined && input.from.slice(0, 7) !== input.targetMonth) {
    throw new Error("対象月は発行期間の開始月と一致させてください");
  }
  if (layout === "week_rows") {
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (days !== 7 && days !== 14) {
      throw new Error("週表の発行期間は7日または14日にしてください");
    }
    // The rows layouts keep Monday weeks (the client's rangeFor
    // starts a week view on Monday), so a span the screen could
    // show always starts on one; anything else is a span no week
    // table ever displayed.
    if (weekStartOf(from) !== from) {
      throw new Error("週表の発行期間は月曜日から始めてください");
    }
    return { from, to };
  }
  if (layout === "year_columns") {
    const year = Number(from.slice(0, 4));
    const schoolYear = Number(from.slice(5, 7)) >= 4 ? year : year - 1;
    if (from !== `${schoolYear}-04-01` || to !== `${schoolYear + 1}-03-31`) {
      throw new Error("年間表の発行期間は年度（4月1日〜翌年3月31日）にしてください");
    }
    return { from, to };
  }
  if (from !== `${input.targetMonth}-01` || to !== monthEndOf(input.targetMonth)) {
    throw new Error("月表の発行期間は対象月の1か月分にしてください");
  }
  return { from, to };
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
 *
 * Issue #49 issues the other table layouts: createPublication
 * names the span it covers (from/to, defaulting to the target
 * month), validated per layout by publicationSpanOf, renders
 * the layout's paper form from the span's range, and stores
 * the span on the row — the period the diff's previous-version
 * lookup and the public range's latest-version lookup read
 * (db/publications.ts periodOf).
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
      const span = publicationSpanOf(view.layout, input);
      const range = await computeRange(db, platformClient, dutyPlatform, auth.schoolId, {
        from: span.from,
        to: span.to,
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
      const printSettings = resolvePrintSettings(
        view.printSettings,
        input.printSettings,
        view.layout,
      );
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
        rangeFrom: span.from,
        rangeTo: span.to,
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
        // The update's own where clause refuses cancelled
        // versions, so a cancellation that landed after the
        // read above surfaces here; tell the two apart.
        const now = await publicationsStore.getPublication(db, auth.schoolId, input.id);
        if (now?.cancelledAt) {
          throw new Error("取り消した版のラベルとメモは編集できません");
        }
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
        // The first version of its view and period: nothing
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
