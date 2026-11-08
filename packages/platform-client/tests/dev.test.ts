import { afterEach, describe, expect, it, vi } from "vitest";

// The adapter guards itself at load time, so every case loads it
// fresh with the environment it needs.
async function loadDev() {
  return import("../src/dev.js");
}

describe("development adapter (explicit opt-in)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("loads with PLATFORM_DEV_AUTH=1 and returns a switchable fixed context", async () => {
    vi.resetModules();
    vi.stubEnv("PLATFORM_DEV_AUTH", "1");
    const { createDevAuthAdapter, createDevAuthContext } = await loadDev();

    const adapter = createDevAuthAdapter();
    const first = await adapter.verifyRequest();
    expect(first.userId).toBe("dev-user");
    expect(first.schoolId).toBe("dev-school");
    expect(first.role).toBe("Admin");

    adapter.setContext({ schoolId: "school-b", role: "Viewer" });
    const second = await adapter.verifyRequest();
    expect(second.schoolId).toBe("school-b");
    expect(second.role).toBe("Viewer");
    expect(second.userId).toBe("dev-user");

    const context = createDevAuthContext({ role: "Editor", teacherId: "t-9" });
    expect(context.role).toBe("Editor");
    expect(context.teacherId).toBe("t-9");
    expect(context.isSuperAdmin).toBe(false);
  });

  it("refuses to load without the explicit opt-in", async () => {
    vi.resetModules();
    vi.stubEnv("PLATFORM_DEV_AUTH", "");
    await expect(loadDev()).rejects.toThrow(/開発専用/);
  });

  it("refuses to load in production even with the opt-in", async () => {
    vi.resetModules();
    vi.stubEnv("PLATFORM_DEV_AUTH", "1");
    vi.stubEnv("NODE_ENV", "production");
    await expect(loadDev()).rejects.toThrow(/開発専用/);
  });
});
