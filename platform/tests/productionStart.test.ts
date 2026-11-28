import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// Process-level startup gate (Issue #132, on top of the Issue #5
// config tests): the real entry point, run as a child process with a
// scrubbed environment, must exit non-zero instead of starting when
// a required secret is missing. The entry loads its configuration
// before it listens, so these runs never open a port or a database
// connection they could succeed with.
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

describe("platform entry point with missing secrets", () => {
  it("does not start without JWT_SECRET", async () => {
    const result = await runEntry({ PATH: process.env.PATH ?? "" });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/JWT_SECRET/);
  });

  it("does not start without PLATFORM_DATABASE_URL", async () => {
    const result = await runEntry({
      PATH: process.env.PATH ?? "",
      JWT_SECRET: "test-only-secret",
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/PLATFORM_DATABASE_URL/);
  });
});
