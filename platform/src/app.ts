import express from "express";
import { createAuthRouter, type AuthRouterDeps } from "./auth/routes.js";

/**
 * The platform HTTP app: the health check the external monitoring pings
 * (8-3-3) and, when the auth dependencies are provided, the login API
 * under /platform/api/v1/auth. The entry point always provides them; the
 * health test builds the app without, so /healthz stays answerable on
 * its own.
 */
export interface AppDeps {
  auth?: AuthRouterDeps;
}

export function createApp(deps: AppDeps = {}) {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.auth) {
    app.use("/platform/api/v1/auth", createAuthRouter(deps.auth));
  }

  return app;
}
