/* eslint-disable no-undef -- Node globals (URL, console) are available at runtime. */
// Builds platform/client when it exists. The platform has no client
// yet (the login screens are a later Issue); until then the
// production build skips this step, so `pnpm build` stays one command
// before and after the client appears.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const clientDir = fileURLToPath(new URL("../client", import.meta.url));
if (!existsSync(clientDir)) {
  console.log("platform/client does not exist yet; skipping the client build.");
} else {
  execFileSync("pnpm", ["exec", "vite", "build", "client"], { stdio: "inherit" });
}
