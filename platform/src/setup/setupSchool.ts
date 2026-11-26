import { runSetupCli } from "./cli.js";

// Operator command (Issue #127): create the first school and its
// administrator. Usage:
//   pnpm --filter @school-manage/platform setup:school \
//     --slug <slug> --name <学校名> --admin-email <メール> --admin-name <名前> [--plan <プラン>]
runSetupCli("school");
