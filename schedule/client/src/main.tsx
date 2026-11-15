import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createScheduleApi } from "./api";
import { createDevApi, devAdapterEnabled } from "./devAdapter";
import "./theme.css";

/**
 * Entry point of the schedule screens (Issue #34). The API口 is the
 * HTTP client by default; the development adapter answers instead
 * only when explicitly enabled (`?dev=1` in a development build, or
 * a build with VITE_SCHEDULE_DEV_ADAPTER=1), so a production build
 * always talks to the server.
 */
const useDev = devAdapterEnabled(
  window.location.search,
  import.meta.env.VITE_SCHEDULE_DEV_ADAPTER,
  import.meta.env.DEV,
);
const api = useDev ? createDevApi() : createScheduleApi();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing root element");

createRoot(rootEl).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
