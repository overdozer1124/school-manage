import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { AuthAccessError } from "@school-manage/platform-client";
import type { ScheduleAuth } from "./auth.js";
import { PlatformRelayError } from "./platformClient.js";
import { createRequestRateLimiter } from "./rateLimit.js";

/**
 * The schedule HTTP app (Issue #34): the health check the external
 * monitoring pings (DESIGN-INTEGRATION 8-3-3), the action endpoints
 * the screens call, and the built screens themselves, served under
 * `/{slug}/schedule/` on the shared domain (8-3-1).
 *
 * The action endpoints are thin: verify the caller (the platform
 * decides, via ScheduleAuth), hand the action the request body with
 * the caller's cookie injected — the actions read the platform with
 * the caller's own session, forwarded as-is (Issue #29's convention)
 * — and answer with the result as JSON. Verdicts keep their shape
 * end to end: an AuthAccessError is its 401 / 403, a platform relay
 * refusal is the platform's own status and body, and the client's
 * 401-vs-403 split (DESIGN-AUTH-TENANCY 4.8) is built on exactly
 * that.
 *
 * The public viewing endpoints (Issue #41) sit beside them under
 * `/{slug}/schedule/public/`: no caller is verified there, and only
 * the PublicAction allowlist is served — the token in the request
 * is the credential, and the actions take no AuthContext at all.
 * Two guards stand on that route instead (Issue #41 review): a
 * per-source request limit, because it is the one surface that
 * answers with no session and each call fans out to several
 * reads; and the path's slug, injected into the request the way
 * the secure route injects the cookie, so the action can check
 * the URL's school against the token's own. The limit's "source"
 * is the forwarded source only when the deployment sets
 * TRUST_PROXY (Issue #41 re-review); until then every request
 * behind the proxy counts as the proxy itself.
 */
export interface ScheduleActionLike {
  run(auth: never, request: never): Promise<unknown>;
}

/** A public action (Issue #41): its run takes the request alone.
 *  There is no caller to verify — the token in the request is the
 *  whole credential — so these are served on their own route and
 *  never mixed into the secure record, where run would be handed
 *  an AuthContext it must not have. */
export interface PublicActionLike {
  run(request: never): Promise<unknown>;
}

export interface ScheduleAppDeps {
  /** Verifies a request into an AuthContext (or throws AuthAccessError). */
  auth: ScheduleAuth;
  /** Builds the actions for one request, bound to its cookie:
   *  the platform reads and the duty source are per-caller. The
   *  record is keyed by action name; a name in ACTION_NAMES that
   *  the assembly does not provide answers 404, like an unknown
   *  name. */
  createActions(cookie: string): Record<string, ScheduleActionLike>;
  /** The public viewing actions (Issue #41), keyed by name; a
   *  name in PUBLIC_ACTION_NAMES that the assembly does not
   *  provide answers 404. When absent, the public route serves
   *  nothing. */
  createPublicActions?: () => Record<string, PublicActionLike>;
  /** The public route's per-source request allowance (Issue #41
   *  review). The default is sized for readers, not crawlers: a
   *  page view costs two calls (bootstrap, then the month's
   *  range) and paging through months costs one each, so 120 a
   *  minute is far above a person's pace and far below a load
   *  attack's. Tests shrink it to reach the 429 in a few calls. */
  publicRateLimit?: { maxRequests: number; windowMs: number };
  /** Express's "trust proxy" setting (TRUST_PROXY, read by the
   *  server config). The rate limit above counts by req.ip, and
   *  behind the reverse proxy of DESIGN 8-3-1 req.ip is the
   *  proxy's own address unless the deployment says which
   *  proxies to trust — without this, every reader of every
   *  school would share the one allowance and legitimate readers
   *  would be refused together (Issue #41 re-review). The
   *  platform sets the same value the same way. */
  trustProxy?: string | undefined;
  /** Directory of the built screens (client/dist). When it does not
   *  exist, only the API and health check are served. */
  clientDistDir?: string;
}

const ACTION_NAMES = [
  "getBootstrap",
  "getRange",
  // Issue #47: the derived summary (school days and the
  // aggregatable items' day counts, per month and per target).
  "getSummary",
  // Issue #35: the cell editors' writes. Events and absences go
  // through the platform relay (Issue #29); daily values are
  // schedule's own writes (Issue #28).
  "createEvent",
  "updateEvent",
  "deleteEvent",
  "createAbsence",
  "updateAbsence",
  "deleteAbsence",
  "setDailyValue",
  "deleteDailyValue",
  // Issue #36: the quick-entry popover's item step reads and
  // rewrites a record's additional items (Issue #29's actions,
  // assembled with the event relay in composition).
  "getEventValues",
  "setEventValues",
  // The duty panel's actions (Issue #38): the rotation preview and
  // apply, and the change / conflict operations of Issue #31. The
  // actions themselves carry the permission checks (duty.write,
  // with the Viewer's own-assignment rule enforced per row).
  "previewRotation",
  "applyRotation",
  "proposeDutyChange",
  "applyDutyChange",
  "declineDutyChange",
  "getDutyChanges",
  "getDutyConflicts",
  "waiveConflict",
  "getDutyChangeCandidates",
  // Issue #39: the settings screens and the confirmation queue.
  // The definition actions (Issue #27), the view actions (Issue
  // #32), the duty definition edits (Issue #30), the kind
  // templates and the pending / confirm relays (Issue #29, with
  // the event half added in #39) and the shared-master relay all
  // existed as action layers; this issue serves them over HTTP.
  "getDefinitions",
  "upsertTargetGroup",
  "deleteTargetGroup",
  "upsertTarget",
  "deleteTarget",
  "upsertItemDefinition",
  "deleteItemDefinition",
  "upsertLocation",
  "deleteLocation",
  "saveSettings",
  "applyPreset",
  "getViews",
  "upsertViewDefinition",
  "deleteViewDefinition",
  "setViewArchived",
  "updateViewColumnWidth",
  "getDutyDefinitions",
  "upsertDutyDefinition",
  "deleteDutyDefinition",
  "getDutyAssignments",
  "setDutyAssignment",
  "moveEvent",
  "moveAbsence",
  "getKindTemplates",
  "upsertKindTemplate",
  "deleteKindTemplate",
  "applyDefaultKindTemplates",
  "getPendingAbsences",
  "confirmAbsence",
  "getPendingEvents",
  "confirmEvent",
  "getMasters",
  "createMaster",
  "updateMaster",
  "deleteMaster",
  // Issue #40: issuing a month table as a versioned document,
  // the version list, and the issued document itself.
  "createPublication",
  "getPublications",
  "getPublication",
  // Issue #48: the version history's record keeping — the
  // label/note correction, the cancellation, and the diff
  // against the previous version.
  "updatePublication",
  "cancelPublication",
  "getPublicationDiff",
  // Issue #41: managing the public viewing tokens (school.admin).
  // The public reads are not here: they take no AuthContext and
  // are served by the public route below (PUBLIC_ACTION_NAMES).
  "createPublicViewToken",
  "getPublicViewTokens",
  "revokePublicViewToken",
  // Issue #84: the absence subdivisions' relay (school.admin).
  "getSubdivisions",
  "createSubdivision",
  "updateSubdivision",
  "deleteSubdivision",
  "applyDefaultSubdivisions",
] as const;

/** The public viewing reads (Issue #41): the whole allowlist of
 *  DESIGN-AUTH-TENANCY 4.5. Any other name on the public route —
 *  including every secure action's name — answers 404. */
const PUBLIC_ACTION_NAMES = ["getPublicBootstrap", "getPublicRange"] as const;

/**
 * The error mapping both action routes share: an AuthAccessError
 * is its 401 / 403 (on the public route, a revoked token's 401),
 * a platform relay refusal is the platform's own status and body
 * (on the public route, an unknown token's 404 rides this shape
 * too), a ZodError names only which input is wrong, and anything
 * else is a generic 500 — a 500 never carries the exception's
 * message, which can name SQL and internals; the detail goes to
 * the server log only.
 */
function sendActionError(res: express.Response, error: unknown): void {
  if (error instanceof AuthAccessError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof PlatformRelayError) {
    // The platform's verdict travels untouched (Issue #29).
    res.status(error.status).json(error.body ?? { error: error.message });
    return;
  }
  if (error instanceof Error && error.name === "ZodError") {
    // Only which input is wrong travels: field paths and the
    // kind of mismatch. The raw message can quote received
    // values, so it stays out of the response.
    const issues = (error as { issues?: unknown }).issues;
    res.status(400).json({
      error: "入力が正しくありません",
      issues: Array.isArray(issues)
        ? issues.map((issue) => {
            const i = issue as { path?: unknown; code?: unknown };
            return {
              path: Array.isArray(i.path) ? i.path.map(String).join(".") : "",
              code: typeof i.code === "string" ? i.code : "invalid",
            };
          })
        : [],
    });
    return;
  }
  console.error("schedule action failed:", error);
  res.status(500).json({ error: "サーバーでエラーが起きました" });
}

export function createApp(deps?: ScheduleAppDeps) {
  const app = express();
  // Behind the reverse proxy (DESIGN 8-3-1), req.ip is the proxy's
  // address unless the deployment says which proxies to trust; the
  // public route's rate limit counts by req.ip, so this decides
  // whose requests are counted together (Issue #41 re-review).
  if (deps?.trustProxy) {
    app.set("trust proxy", deps.trustProxy);
  }
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps) {
    const publicRateLimiter = createRequestRateLimiter(
      deps.publicRateLimit ?? { maxRequests: 120, windowMs: 60_000 },
    );

    app.post("/:slug/schedule/api/:action", async (req, res) => {
      const actionName = req.params.action as string;
      if (!(ACTION_NAMES as readonly string[]).includes(actionName)) {
        res.status(404).json({ error: `unknown action: ${actionName}` });
        return;
      }
      try {
        const auth = await deps.auth.verifyRequest(req);
        const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
        const actions = deps.createActions(cookie);
        const action = actions[actionName];
        if (!action) {
          res.status(404).json({ error: `unknown action: ${actionName}` });
          return;
        }
        const body =
          typeof req.body === "object" && req.body !== null
            ? (req.body as Record<string, unknown>)
            : {};
        const result = await action.run(auth as never, { ...body, cookie } as never);
        res.json(result ?? null);
      } catch (error) {
        sendActionError(res, error);
      }
    });

    // The public viewing route (Issue #41): no caller is verified
    // and no cookie is injected — the token in the request body is
    // the whole credential, and the actions behind this route are
    // PublicActions, whose run takes the request alone. Only the
    // allowlist names are served; a secure action's name here is
    // an unknown action, exactly as a public name is on the route
    // above.
    //
    // Every hit on this route counts against the source address's
    // allowance first — the limit guards the surface, not just
    // the two served names — and the path's slug is injected into
    // the request (the path's value wins over any the body sent),
    // as the secure route injects the caller's cookie.
    app.post("/:slug/schedule/public/:action", async (req, res) => {
      if (!publicRateLimiter.tryAcquire(req.ip ?? "unknown")) {
        res.status(429).json({
          error: "リクエストの回数が上限を超えました。しばらく待ってから再度お試しください。",
        });
        return;
      }
      const actionName = req.params.action as string;
      if (!(PUBLIC_ACTION_NAMES as readonly string[]).includes(actionName)) {
        res.status(404).json({ error: `unknown action: ${actionName}` });
        return;
      }
      try {
        const actions = deps.createPublicActions?.() ?? {};
        const action = actions[actionName];
        if (!action) {
          res.status(404).json({ error: `unknown action: ${actionName}` });
          return;
        }
        const body =
          typeof req.body === "object" && req.body !== null
            ? (req.body as Record<string, unknown>)
            : {};
        const result = await action.run({ ...body, slug: req.params.slug } as never);
        res.json(result ?? null);
      } catch (error) {
        sendActionError(res, error);
      }
    });

    const distDir =
      deps.clientDistDir ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client/dist");
    if (existsSync(path.join(distDir, "index.html"))) {
      app.use("/:slug/schedule", express.static(distDir));
      // SPA fallback: any path under the app that is not a file is
      // the screen itself (the screens route by state, not by URL,
      // so this is mostly the entry path with a trailing slash).
      app.get("/:slug/schedule/*splat", (_req, res) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
    }
  }

  return app;
}
