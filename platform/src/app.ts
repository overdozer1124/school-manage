import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createAbsencesRouter, type AbsencesRouterDeps } from "./absences/routes.js";
import { createAuthRouter, type AuthRouterDeps } from "./auth/routes.js";
import { createCalendarRouter, type CalendarRouterDeps } from "./calendar/routes.js";
import { createChangesRouter, type ChangesRouterDeps } from "./changes/routes.js";
import { createEventsRouter, type EventsRouterDeps } from "./events/routes.js";
import { createMastersRouter, type MastersRouterDeps } from "./masters/routes.js";
import { createMembersRouter, type MembersRouterDeps } from "./memberships/routes.js";
import { createPublicReadRouter, type PublicReadRouterDeps } from "./publicRead/routes.js";

/**
 * The platform HTTP app: the health check the external monitoring pings
 * (8-3-3) and, when the dependencies are provided, the login API under
 * /platform/api/v1/auth and the change refetch API under
 * /platform/api/v1/changes. The entry point always provides them; the
 * health test builds the app without, so /healthz stays answerable on
 * its own.
 */
export interface AppDeps {
  auth?: AuthRouterDeps;
  changes?: ChangesRouterDeps;
  masters?: MastersRouterDeps;
  events?: EventsRouterDeps;
  calendar?: CalendarRouterDeps;
  absences?: AbsencesRouterDeps;
  publicRead?: PublicReadRouterDeps;
  members?: MembersRouterDeps;
  /** Directory of the built login screens (client/dist). When it
   *  does not exist the /login path stays unserved; tests point it
   *  at a fixture directory. */
  loginClientDistDir?: string;
}

export function createApp(deps: AppDeps = {}) {
  const app = express();
  // Behind the reverse proxy (DESIGN 8-3-1), req.ip is the proxy's
  // address unless the deployment says which proxies to trust; the
  // login rate limit counts by req.ip, so this decides whose failures
  // are counted together (Issue #16).
  if (deps.auth?.config.trustProxy) {
    app.set("trust proxy", deps.auth.config.trustProxy);
  }
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.auth) {
    app.use("/platform/api/v1/auth", createAuthRouter(deps.auth));
  }

  if (deps.changes) {
    app.use("/platform/api/v1", createChangesRouter(deps.changes));
  }

  if (deps.masters) {
    app.use("/platform/api/v1", createMastersRouter(deps.masters));
  }

  if (deps.events) {
    app.use("/platform/api/v1", createEventsRouter(deps.events));
  }

  if (deps.calendar) {
    app.use("/platform/api/v1", createCalendarRouter(deps.calendar));
  }

  if (deps.absences) {
    app.use("/platform/api/v1", createAbsencesRouter(deps.absences));
  }

  // Membership administration (Issue #128): a school administrator
  // invites, approves and manages their own school's members.
  if (deps.members) {
    app.use("/platform/api/v1", createMembersRouter(deps.members));
  }

  // The public-read path (Issue #82): the schedule server's
  // session-less reads for the public viewing pages, authenticated
  // by the service credential rather than a member's session.
  if (deps.publicRead) {
    app.use("/platform/api/v1", createPublicReadRouter(deps.publicRead));
  }

  // The login screens (Issue #129): the built platform/client is
  // served under /login on the shared domain (8-3-1), the same
  // arrangement as the schedule server's screens. The entry file
  // sits beside src/ in a checkout and beside the bundled server
  // in production, so ../client/dist names the same directory in
  // both. When the build output does not exist, /login stays
  // unserved rather than answering with something else.
  const loginDistDir =
    deps.loginClientDistDir ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client/dist");
  if (existsSync(path.join(loginDistDir, "index.html"))) {
    const loginIndex = path.join(loginDistDir, "index.html");
    // The exact path first: the Google callback returns to
    // /login?code=…&state=…, and a static directory redirect would
    // be one more hop for it to survive.
    app.get("/login", (_req, res) => {
      res.sendFile(loginIndex);
    });
    app.use("/login", express.static(loginDistDir));
    // SPA fallback: the screens route by state, not by URL, so any
    // path under /login that is not a file is the screen itself.
    app.get("/login/*splat", (_req, res) => {
      res.sendFile(loginIndex);
    });
  }

  return app;
}
