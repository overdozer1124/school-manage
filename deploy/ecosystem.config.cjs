/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- PM2 loads
   ecosystem files as CommonJS; require/module/__dirname are Node's CJS globals. */
// PM2 process definitions for production (Issue #132).
//
// This mirrors how school-timetable runs on the same VPS: PM2 keeps
// the processes alive, and `pm2 save` + `pm2 startup` revive them
// after a reboot. The real environment lives OUTSIDE the repository,
// one file per service under /etc/school-manage/ (school-timetable
// keeps its canonical env file outside its repository the same way),
// owned by root, readable only by the service user (chmod 600). PM2
// reads those files via env_file; nothing secret is written here.
//
// Start from the repository root:
//   pm2 start deploy/ecosystem.config.cjs
const path = require("node:path");

const root = path.join(__dirname, "..");

module.exports = {
  apps: [
    {
      name: "school-manage-platform",
      cwd: path.join(root, "platform"),
      script: "dist/index.js",
      interpreter: "node",
      env_file: "/etc/school-manage/platform.env",
      env: { NODE_ENV: "production" },
    },
    {
      name: "school-manage-schedule",
      cwd: path.join(root, "schedule"),
      script: "dist/index.js",
      interpreter: "node",
      env_file: "/etc/school-manage/schedule.env",
      env: { NODE_ENV: "production" },
    },
  ],
};
