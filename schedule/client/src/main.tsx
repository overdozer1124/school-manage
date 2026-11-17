import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PublicApp } from "./PublicApp";
import { createPublicApi, createScheduleApi } from "./api";
import { createDevApi, createDevPublicApi, devAdapterEnabled } from "./devAdapter";
import "./theme.css";

/**
 * Entry point of the schedule screens (Issue #34). The API口 is the
 * HTTP client by default; the development adapter answers instead
 * only when explicitly enabled (`?dev=1` in a development build, or
 * a build with VITE_SCHEDULE_DEV_ADAPTER=1), so a production build
 * always talks to the server.
 *
 * The public viewing page (Issue #41) is served by the same entry:
 * the server answers every path under /{slug}/schedule/ with this
 * page, so a `/public-view/{token}` path is told apart here, by
 * the path alone — it mounts the read-only public screen with the
 * token from the URL, and the signed-in app is never mounted.
 */
const useDev = devAdapterEnabled(
  window.location.search,
  import.meta.env.VITE_SCHEDULE_DEV_ADAPTER,
  import.meta.env.DEV,
);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing root element");

const publicMatch = /\/public-view\/([^/?#]+)/.exec(window.location.pathname);

createRoot(rootEl).render(
  <StrictMode>
    {publicMatch ? (
      <PublicApp
        api={
          useDev
            ? createDevPublicApi(decodeURIComponent(publicMatch[1] as string))
            : createPublicApi(decodeURIComponent(publicMatch[1] as string))
        }
      />
    ) : (
      <App api={useDev ? createDevApi() : createScheduleApi()} />
    )}
  </StrictMode>,
);
