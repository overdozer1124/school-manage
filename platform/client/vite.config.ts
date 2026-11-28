import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Build for the login screens (Issue #129). The platform server
 * serves the build under /login on the shared domain
 * (DESIGN-INTEGRATION 8-3-1). Unlike the schedule screens, whose
 * prefix carries a school slug this build cannot know, the login
 * path is fixed, so asset URLs are absolute under /login/ and the
 * entry page works both at /login and at any path below it.
 * During development, `vite dev` serves the screens on their own
 * (http://localhost:5174/login/) and proxies the platform API to
 * the platform server.
 */
export default defineConfig({
  plugins: [react()],
  base: "/login/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/platform": "http://localhost:3001",
    },
  },
});
