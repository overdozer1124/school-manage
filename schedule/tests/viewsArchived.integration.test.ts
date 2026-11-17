import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthContext, type Role } from "@school-manage/platform-client";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import * as publicationsStore from "../src/db/publications.js";
import * as schoolCacheStore from "../src/db/schoolCache.js";
import type { PlatformApiClient } from "../src/platformClient.js";
import { PlatformRelayError } from "../src/platformClient.js";
import { createPublicationActions } from "../src/publications/actions.js";
import { createPublicActions, createPublicTokenAdminActions } from "../src/publicViews/actions.js";
import { createPublicPlatformClient } from "../src/publicViews/publicPlatform.js";
import { createViewActions } from "../src/views/actions.js";

// View archiving tests (Issue #87): taking a view off the list
// flips is_archived and nothing else — the view's issued
// publications stay readable, its public URL keeps opening (the
// URL has its own stop: revoking the token), an edit does not
// quietly un-archive it, and bringing it back restores it whole.
// Deleting a view with publications still refuses, now naming
// archiving as the alternative.
const url = process.env.SCHEDULE_DATABASE_URL;

const SCHOOL = "school-87";
const SLUG = "school-87";
const DOCUMENT_HTML = "<html><body>発行した版</body></html>";

type ViewActions = ReturnType<typeof createViewActions>;
type PublicationActions = ReturnType<typeof createPublicationActions>;
type TokenAdminActions = ReturnType<typeof createPublicTokenAdminActions>;
type PublicActions = ReturnType<typeof createPublicActions>;

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

/** The member-path platform client: nothing in this file reads
 *  through it (publication reads and token issuance without a
 *  cookie never call it), so any call is a test bug. */
const unusedPlatformClient = {
  getJson: async (): Promise<never> => {
    throw new Error("platform client not used in this test");
  },
  requestJson: async (): Promise<never> => {
    throw new Error("platform client not used in this test");
  },
} as unknown as PlatformApiClient;

/** The public-read fake: the school record and empty lists. The
 *  public bundle of an empty month is enough to judge that the
 *  archived view still resolves and renders. */
function publicFetch(input: string | URL | Request): Promise<Response> {
  const raw = String(input).replace("http://platform.test", "");
  const [path] = raw.split("?");
  const body = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (path === "/platform/api/v1/public-read/school") {
    return Promise.resolve(body({ id: SCHOOL, name: "テスト学校", slug: SLUG }));
  }
  return Promise.resolve(body({ items: [] }));
}

describe.skipIf(!url)("schedule view archiving (Issue #87)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: Db;
  let views: ViewActions;
  let publications: PublicationActions;
  let tokenAdmin: TokenAdminActions;
  let publicActions: PublicActions;

  const admin = auth(SCHOOL, "Admin");
  const editor = auth(SCHOOL, "Editor");

  beforeAll(async () => {
    const adminConn = postgres(url as string, { max: 1 });
    await adminConn.unsafe("drop schema public cascade");
    await adminConn.unsafe("create schema public");
    await adminConn.unsafe("drop schema if exists drizzle cascade");
    await adminConn.end();

    const created = createDb(url);
    db = created.db;
    queryClient = created.queryClient;
    await runMigrations(db);
    views = createViewActions(db);
    publications = createPublicationActions(db, unusedPlatformClient);
    tokenAdmin = createPublicTokenAdminActions(db, unusedPlatformClient);
    publicActions = createPublicActions(
      db,
      createPublicPlatformClient({
        baseUrl: "http://platform.test",
        serviceToken: "test-service-token",
        fetchImpl: publicFetch as typeof fetch,
      }),
    );
    await schoolCacheStore.upsertSchoolCache(db, {
      schoolId: SCHOOL,
      name: "テスト学校",
      slug: SLUG,
    });

    await views.upsertViewDefinition.run(admin, {
      id: "view-guardian",
      name: "保護者用月表",
      layout: "month_rows",
      audience: "guardian",
      periodScope: "month",
      columns: [{ id: "col-events", sourceKind: "event_category", sort: 1 }],
    });
    await views.upsertViewDefinition.run(admin, {
      id: "view-staff",
      name: "職員用月表",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
      columns: [],
    });
    // An issued version of the guardian view, written through
    // the store the publication actions read back (the render
    // path itself is Issue #40's tests).
    await publicationsStore.insertPublication(db, SCHOOL, {
      id: "pub-1",
      viewDefinitionId: "view-guardian",
      targetMonth: "2027-10",
      versionLabel: "第1版",
      publishedAt: new Date("2027-09-25T00:00:00Z"),
      publishedBy: "user-school-87",
      snapshotNote: null,
      printSettings: { paper: "A4", orientation: "landscape", marginMm: 10, fontScale: "medium" },
      documentFormat: "html",
      documentHtml: DOCUMENT_HTML,
    });
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("archives and restores a view, Admin only, keeping it in getViews throughout", async () => {
    const before = await views.getViews.run(admin, null);
    expect(before.find((v) => v.id === "view-staff")?.isArchived).toBe(false);

    // definition.write: an Editor cannot archive.
    await expect(
      views.setViewArchived.run(editor, { id: "view-staff", archived: true }),
    ).rejects.toMatchObject({ status: 403 });
    // Another school's view is not found, not leaked.
    await expect(
      views.setViewArchived.run(auth("school-other", "Admin"), {
        id: "view-staff",
        archived: true,
      }),
    ).rejects.toThrow(/view definition not found/);

    const archived = await views.setViewArchived.run(admin, {
      id: "view-staff",
      archived: true,
    });
    expect(archived.isArchived).toBe(true);
    expect(archived.columns).toEqual([]);
    // getViews still carries the view, flag and all: the
    // settings screen reads the same list and shows archived
    // views on request, and the bootstrap's switcher filtering
    // is a display choice on top of it.
    const during = await views.getViews.run(admin, null);
    expect(during.find((v) => v.id === "view-staff")?.isArchived).toBe(true);

    // An edit while archived does not bring the view back.
    const edited = await views.upsertViewDefinition.run(admin, {
      id: "view-staff",
      name: "職員用月表（改）",
      layout: "month_rows",
      audience: "staff",
      periodScope: "month",
    });
    expect(edited.isArchived).toBe(true);

    const restored = await views.setViewArchived.run(admin, {
      id: "view-staff",
      archived: false,
    });
    expect(restored.isArchived).toBe(false);
    expect(restored.name).toBe("職員用月表（改）");
  });

  it("keeps the issued publications of an archived view readable, and delete still refuses naming archiving", async () => {
    await views.setViewArchived.run(admin, { id: "view-guardian", archived: true });

    const list = await publications.getPublications.run(admin, { viewId: "view-guardian" });
    expect(list.map((p) => p.id)).toEqual(["pub-1"]);
    const doc = await publications.getPublication.run(admin, { id: "pub-1" });
    expect(doc.documentHtml).toBe(DOCUMENT_HTML);

    // Deleting is still refused (the publications foreign key),
    // and the refusal now names the alternative this issue adds.
    const refusal = await views.deleteViewDefinition
      .run(admin, { id: "view-guardian" })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PlatformRelayError);
    expect((refusal as PlatformRelayError).status).toBe(409);
    expect((refusal as PlatformRelayError).body).toEqual({
      error: "発行した版があるビューは削除できません。一覧から外すことはできます",
    });

    await views.setViewArchived.run(admin, { id: "view-guardian", archived: false });
  });

  it("keeps the public URL of an archived view open; revoking the token is what closes it", async () => {
    const issued = await tokenAdmin.createPublicViewToken.run(admin, {
      viewId: "view-guardian",
    });
    await views.setViewArchived.run(admin, { id: "view-guardian", archived: true });

    const boot = await publicActions.getPublicBootstrap.run({
      token: issued.token,
      slug: SLUG,
    });
    expect(boot.view.id).toBe("view-guardian");
    expect(boot.view.isArchived).toBe(true);
    const range = await publicActions.getPublicRange.run({
      token: issued.token,
      slug: SLUG,
      from: "2027-10-01",
      to: "2027-10-31",
    });
    expect(range.view.id).toBe("view-guardian");
    expect(range.days).toHaveLength(31);

    // The URL's own stop still works on an archived view.
    await tokenAdmin.revokePublicViewToken.run(admin, { id: issued.id });
    await expect(
      publicActions.getPublicBootstrap.run({ token: issued.token, slug: SLUG }),
    ).rejects.toMatchObject({ status: 401 });

    await views.setViewArchived.run(admin, { id: "view-guardian", archived: false });
  });
});
