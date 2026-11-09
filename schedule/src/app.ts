import express from "express";

/**
 * The schedule HTTP app: for now, the health check the external
 * monitoring pings (DESIGN-INTEGRATION 8-3-3). The screens and the
 * action endpoints arrive with their own issues, on top of the auth,
 * permission and tenancy foundations laid in this one.
 */
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
