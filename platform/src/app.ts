import express from "express";
import { createAuthRouter, type AuthRouterDeps } from "./auth/routes.js";
import { createChangesRouter, type ChangesRouterDeps } from "./changes/routes.js";

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

  return app;
}
