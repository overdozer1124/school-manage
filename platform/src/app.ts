import express from "express";

/**
 * The platform HTTP app. For now it only exposes the health check that the
 * external monitoring pings (8-3-3); the API surface arrives with the
 * login and tenancy issues.
 */
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
