import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthAccessError, defineActions, publicAction } from "@school-manage/platform-client";
import {
  audienceColumns,
  audienceItems,
  forAudience,
  viewAudienceRank,
  type Audience,
  type AudienceColumn,
  type AudienceItem,
} from "@school-manage/calendar-types";
import * as definitionsStore from "../db/definitions.js";
import * as tokensStore from "../db/publicTokens.js";
import * as schoolCacheStore from "../db/schoolCache.js";
import * as viewsStore from "../db/views.js";
import { tenantDb } from "../db/tenant.js";
import { scheduleAction } from "../permissions.js";
import {
  PlatformRelayError,
  unwrapPlatformResult,
  type PlatformApiClient,
} from "../platformClient.js";
import { computeRange } from "../range/actions.js";
import type { RangeResult } from "../range/types.js";
import type { PublicPlatformClient } from "./publicPlatform.js";
import {
  createPublicViewTokenInputSchema,
  getPublicBootstrapInputSchema,
  getPublicRangeInputSchema,
  getPublicViewTokensInputSchema,
  revokePublicViewTokenInputSchema,
} from "./types.js";

/** The database handle type, taken from tenantDb so this module
 *  never imports the raw client (kept behind src/db by lint). */
type Db = Parameters<typeof tenantDb>[0];

const ME_PATH = "/platform/api/v1/auth/me";

/**
 * The public token itself (Issue #41): 32 random bytes, base64url.
 * The URL carries it; the database carries only its SHA-256 hash,
 * so the stored rows can verify a presented token without being
 * able to reproduce one. 32 bytes puts guessing out of reach; the
 * revocation on the row is what answers a URL that has spread too
 * far (DESIGN schedule 9).
 */
export function hashPublicToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newPublicToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashPublicToken(token) };
}

/** The audiences a public token may be issued for (DESIGN-AUTH-
 *  TENANCY 4.5): guardian, student and public. Staff is the one
 *  audience a token must never carry — a staff view names people. */
const PUBLIC_AUDIENCES: readonly string[] = ["guardian", "student", "public"];

/**
 * The token management actions (Issue #41), declared school.admin
 * (DESIGN-AUTH-TENANCY 4.4 puts issuing and revoking public tokens
 * there, with the settings and preset application). Issuing is the
 * one moment the raw token exists on this server: the response
 * carries it once, and the list and revoke actions — like the
 * database — only ever see the hash's row.
 *
 * Issuing also syncs the school cache (DESIGN-AUTH-TENANCY 3.1)
 * from the platform, with the caller's own cookie: the public
 * route resolves the URL's slug through that cache, so the
 * school's slug must be on record here before its URLs can
 * answer, and issuance is the first moment a school needs it
 * to be. The sync is best-effort — the cache is a cache, and a
 * platform that does not answer never blocks an issuance; the
 * next issuance retries it.
 */
export function createPublicTokenAdminActions(db: Db, platformClient: PlatformApiClient) {
  return defineActions({
    createPublicViewToken: scheduleAction("school.admin", async ({ auth, request }) => {
      const input = createPublicViewTokenInputSchema.parse(request);
      const view = (await viewsStore.getViews(db, auth.schoolId)).find(
        (v) => v.id === input.viewId,
      );
      if (!view) {
        // A 404 in the platform's refusal shape, like the public
        // side's own not-found answers: the settings screen shows
        // the reason instead of an opaque 500 (Issue #41 review).
        throw new PlatformRelayError({
          status: 404,
          body: { error: "ビューが見つかりません" },
        });
      }
      if (!PUBLIC_AUDIENCES.includes(view.audience)) {
        // A reasoned refusal in the platform's 4xx shape, so the
        // settings screen shows why, not an opaque 500 (the PR #79
        // convention for refusals this layer owns).
        throw new PlatformRelayError({
          status: 400,
          body: { error: "職員用ビューには公開URLを発行できません" },
        });
      }
      const { token, tokenHash } = newPublicToken();
      const row = await tokensStore.insertPublicViewToken(db, auth.schoolId, {
        id: randomUUID(),
        viewDefinitionId: view.id,
        tokenHash,
        createdBy: auth.userId,
      });
      if (input.cookie) {
        try {
          const me = unwrapPlatformResult(await platformClient.getJson(ME_PATH, input.cookie));
          const school = (
            me as { school?: { schoolId?: unknown; name?: unknown; slug?: unknown } } | null
          )?.school;
          if (
            school?.schoolId === auth.schoolId &&
            typeof school.name === "string" &&
            typeof school.slug === "string"
          ) {
            await schoolCacheStore.upsertSchoolCache(db, {
              schoolId: auth.schoolId,
              name: school.name,
              slug: school.slug,
            });
          }
        } catch {
          // Best-effort, by design (see the note above): a failed
          // sync leaves the cache as it was and the issuance
          // standing; nothing about the token depends on it.
        }
      }
      return { ...row, token };
    }),

    getPublicViewTokens: scheduleAction("school.admin", async ({ auth, request }) => {
      const input = getPublicViewTokensInputSchema.parse(request ?? {});
      return tokensStore.listPublicViewTokens(db, auth.schoolId, input.viewId);
    }),

    revokePublicViewToken: scheduleAction("school.admin", async ({ auth, request }) => {
      const input = revokePublicViewTokenInputSchema.parse(request);
      const row = await tokensStore.revokePublicViewToken(db, auth.schoolId, input.id, new Date());
      if (!row) {
        // The same 404 shape as the issuing side's missing view
        // (Issue #41 review): a stale id on the settings screen
        // is a "not there", not a server error.
        throw new PlatformRelayError({
          status: 404,
          body: { error: "公開URLが見つかりません" },
        });
      }
      return row;
    }),
  });
}

/** What a presented token resolves to: its school and its view. */
interface PublicViewContext {
  schoolId: string;
  view: Awaited<ReturnType<typeof viewsStore.getViews>>[number];
}

/**
 * Resolves a presented token to its view. An unknown token is a
 * 404 (there is nothing here — carried in the platform's refusal
 * shape, as AuthAccessError holds only the 401 / 403 verdicts of
 * DESIGN-AUTH-TENANCY 4.8); a revoked one is a 401 (there was, and
 * it was ended — the answer 4.8's split gives a dead credential).
 * The view is read fresh on every call: a view edited after its
 * token was issued is shown as it now is, and a deleted view takes
 * its tokens with it (the schema's cascade), so a missing view is
 * the 404 again.
 *
 * The URL's slug is checked against the token's school, resolved
 * through the school cache (Issue #41 review): the token alone
 * would answer under any school's slug, so a URL could show one
 * school's table under another school's address. A slug that
 * names a different school — or no school this server has on
 * record — is the same 404 as an unknown token: the URL as a
 * whole names nothing here, and the answer does not say which
 * half of it missed.
 */
async function resolvePublicView(db: Db, token: string, slug: string): Promise<PublicViewContext> {
  const row = await tokensStore.findPublicViewTokenByHash(db, hashPublicToken(token));
  if (!row) {
    throw new PlatformRelayError({
      status: 404,
      body: { error: "公開URLが見つかりません" },
    });
  }
  const slugSchoolId = await schoolCacheStore.findSchoolIdBySlug(db, slug);
  if (slugSchoolId !== row.schoolId) {
    throw new PlatformRelayError({
      status: 404,
      body: { error: "公開URLが見つかりません" },
    });
  }
  if (row.revokedAt) {
    throw new AuthAccessError(401, "この公開URLは無効化されています");
  }
  const view = (await viewsStore.getViews(db, row.schoolId)).find(
    (v) => v.id === row.viewDefinitionId,
  );
  if (!view) {
    throw new PlatformRelayError({
      status: 404,
      body: { error: "公開URLが見つかりません" },
    });
  }
  return { schoolId: row.schoolId, view };
}

/** The school year (April to March) a YYYY-MM-DD date belongs to. */
function schoolYearOf(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

function todayText(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * One event as the public side may see it. The platform has
 * already shaped the record for the view's audience (assignees
 * dropped, staff-axis targets dropped, DESIGN-INTEGRATION 6); this
 * layer applies the same shaping again, so the guarantee "no
 * assignees, no staff targets, no creator / updater ids" is this
 * layer's own and does not rest on the caller's fidelity
 * (DESIGN-AUTH-TENANCY 4.5: 職員以外に返さないもの).
 */
function publicEvent(event: Record<string, unknown>, audience: Audience): Record<string, unknown> {
  const shaped = forAudience(event as { assignees: readonly unknown[] }, audience) as Record<
    string,
    unknown
  >;
  const body = { ...shaped };
  delete body.createdBy;
  delete body.updatedBy;
  return body;
}

/**
 * One daily / additional-item value as the public side may see it:
 * the value itself, without the person it names (valuePersonId)
 * and without the creator / updater stamps — a person's id is
 * staff information wherever it appears (DESIGN-AUTH-TENANCY 4.5),
 * the same rule publicEvent applies to the events themselves.
 */
function publicValue<T extends { valuePersonId: string | null }>(value: T): T {
  const body = { ...value, valuePersonId: null } as Record<string, unknown>;
  delete body["createdBy"];
  delete body["updatedBy"];
  return body as T;
}

/** A range bundle with everything staff-shaped taken out of it. */
function publicRange(range: RangeResult, audience: Audience): RangeResult {
  return {
    ...range,
    days: range.days.map((day) => ({
      ...day,
      events: day.events.map((event) => publicEvent(event, audience)),
      // Absences and duties are staff dynamics: a non-staff view's
      // computeRange never fetches them, and the public bundle
      // states that by construction rather than by that promise.
      absences: [],
      dailyValues: day.dailyValues.map((value) => publicValue(value)),
      dutyAssignments: [],
    })),
    undecided: range.undecided.map((group) => ({
      ...group,
      events: group.events.map((event) => publicEvent(event, audience)),
    })),
    eventValues: range.eventValues.map((value) => publicValue(value)),
    conflicts: [],
  };
}

/**
 * The public actions (Issue #41): the allowlist of DESIGN-AUTH-
 * TENANCY 4.5, declared with platform-client's publicAction, so
 * they take no AuthContext at all — there is no caller, only a
 * token. Being a different type from the secure actions is the
 * guarantee: a write action cannot be registered here, and these
 * cannot be registered where a SecureAction is required (the type
 * test in tests/publicViews.integration.test.ts pins both).
 *
 * The reads go through computeRange with the token's own view, so
 * the public table is drawn from exactly the staff table's
 * computation, narrowed by the view's audience — the platform is
 * asked with the audience named, and applies its own filter
 * (DESIGN-INTEGRATION 6), and this layer shapes what comes back
 * once more (publicRange above). The platform reads carry no user
 * cookie: there is no user. They go through the platform's
 * public-read path instead (Issue #82), authenticated by the
 * service credential the PublicPlatformClient presents, with the
 * school and the audience named on every request — the school's
 * name included, so nothing here asks /auth/me for it.
 */
export function createPublicActions(db: Db, publicClient: PublicPlatformClient) {
  return defineActions({
    getPublicBootstrap: publicAction(async ({ request }) => {
      const input = getPublicBootstrapInputSchema.parse(request);
      const { schoolId, view } = await resolvePublicView(db, input.token, input.slug);
      const audience = view.audience as Audience;
      const rank = viewAudienceRank(audience);
      const year = schoolYearOf(todayText());
      const [school, holidays, grades, definitionSet] = await Promise.all([
        publicClient.getSchool(schoolId, audience),
        publicClient.getHolidays(schoolId, audience, {
          from: `${year}-04-01`,
          to: `${year + 1}-03-31`,
        }),
        publicClient.getGrades(schoolId, audience),
        definitionsStore.getDefinitionSet(db, schoolId),
      ]);

      // The view's own filter, applied exactly as computeRange
      // applies it (Issue #32's pure functions): the columns the
      // audience may see, and only the items those columns carry
      // (DESIGN schedule 9: whitelist, not hiding).
      const itemSlices = definitionSet.itemDefinitions as unknown as readonly Pick<
        AudienceItem,
        "id" | "defaultVisibility"
      >[];
      const keptColumns = audienceColumns(
        view.columns.map((column): AudienceColumn & { id: string } => ({
          id: column.id,
          sourceKind: column.sourceKind as AudienceColumn["sourceKind"],
          itemDefinitionId: column.itemDefinitionId,
          dutyDefinitionId: column.dutyDefinitionId,
        })),
        itemSlices,
        rank,
      );
      const keptColumnIds = new Set(keptColumns.map((column) => column.id));
      const columns = view.columns.filter((column) => keptColumnIds.has(column.id));
      const keptItems = audienceItems(itemSlices, keptColumns, rank);
      const keptItemIds = new Set(keptItems.map((item) => item.id));
      const itemDefinitions = definitionSet.itemDefinitions.filter((item) =>
        keptItemIds.has(item.id),
      );
      const usedGroupIds = new Set<string>();
      for (const column of columns) {
        if (column.targetGroupId) usedGroupIds.add(column.targetGroupId);
      }
      for (const item of itemDefinitions) {
        if (item.targetGroupId) usedGroupIds.add(item.targetGroupId);
      }
      const targetGroups = definitionSet.targetGroups.filter((group) => usedGroupIds.has(group.id));

      return {
        school: {
          id: schoolId,
          name: typeof school["name"] === "string" ? school["name"] : null,
        },
        view: { ...view, columns },
        itemDefinitions,
        targetGroups,
        // The grade axis's members label the columns' per-grade
        // values (下校時刻 by grade). They are the one master the
        // public side receives: grades name classes of children,
        // never people. The staff master is not read at all.
        grades,
        holidays,
      };
    }),

    getPublicRange: publicAction(async ({ request }) => {
      const input = getPublicRangeInputSchema.parse(request);
      const { schoolId, view } = await resolvePublicView(db, input.token, input.slug);
      const audience = view.audience as Audience;
      // The range computation reads the platform through the
      // public-read adapter bound to this token's school and the
      // view's audience; the cookie it threads through is inert
      // there (there is no user), and a non-staff view never asks
      // it for absences at all.
      const range = await computeRange(
        db,
        publicClient.asPlatformClient(schoolId, audience),
        undefined,
        schoolId,
        {
          from: input.from,
          to: input.to,
          viewId: view.id,
          cookie: "",
        },
      );
      return publicRange(range, audience);
    }),
  });
}
