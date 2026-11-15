import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Build for the schedule screens (Issue #34). The app is served from
 * `/{slug}/schedule/` on the shared domain (DESIGN-INTEGRATION
 * 8-3-1), under a slug this build does not know, so asset URLs are
 * relative ("./") and the bundle works under any prefix. During
 * development, `vite dev` serves the screens on their own and the
 * development adapter (?dev=1) can answer for the API; API calls to
 * ./api are proxied to the schedule server when one is running.
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3002",
    },
  },
});
