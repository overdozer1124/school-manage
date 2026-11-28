import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createLoginApi } from "./api";
import "./theme.css";

/**
 * Entry point of the login screens (Issue #129). The platform
 * server serves this build under /login; the API口 is the HTTP
 * client for the platform's login API on the same domain.
 */
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing root element");

createRoot(rootEl).render(
  <StrictMode>
    <App api={createLoginApi()} />
  </StrictMode>,
);
