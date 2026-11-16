import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { AuthAccessError } from "@school-manage/platform-client";
import type { ScheduleAuth } from "./auth.js";
import { PlatformRelayError } from "./platformClient.js";

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
 */
export interface ScheduleActionLike {
  run(auth: never, request: never): Promise<unknown>;
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
  /** Directory of the built screens (client/dist). When it does not
   *  exist, only the API and health check are served. */
  clientDistDir?: string;
}

const ACTION_NAMES = [
  "getBootstrap",
  "getRange",
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
] as const;

export function createApp(deps?: ScheduleAppDeps) {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps) {
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
        // A 500 never carries the exception's message: database and
        // other internal errors name SQL and internals that must not
        // reach the screen. The detail goes to the server log only.
        console.error("schedule action failed:", error);
        res.status(500).json({ error: "サーバーでエラーが起きました" });
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
