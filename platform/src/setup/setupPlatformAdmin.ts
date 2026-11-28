import { runSetupCli } from "./cli.js";

// Operator command (Issue #127): add a person to platform_admins.
// Usage:
//   pnpm --filter @school-manage/platform setup:platform-admin \
//     --email <メール> [--name <名前>]
runSetupCli("platform-admin");
