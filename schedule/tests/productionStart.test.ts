import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// Process-level startup gate (Issue #132, same stance as the
// platform's Issue #5): the real entry point, run as a child process
// with a scrubbed environment, must exit non-zero instead of
// starting when a required value is missing. The entry loads its
// configuration before anything else, so these runs never open a
// port or a database connection they could succeed with.
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function runEntry(env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [tsxCli, entry], {
      env,
      timeout: 15_000,
    });
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

describe("schedule entry point with missing configuration", () => {
  it("does not start without SCHEDULE_DATABASE_URL", async () => {
    const result = await runEntry({ PATH: process.env.PATH ?? "" });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/SCHEDULE_DATABASE_URL/);
  });

  it("does not start without PLATFORM_BASE_URL", async () => {
    const result = await runEntry({
      PATH: process.env.PATH ?? "",
      SCHEDULE_DATABASE_URL: "postgres://127.0.0.1:1/unused",
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/PLATFORM_BASE_URL/);
  });
});
