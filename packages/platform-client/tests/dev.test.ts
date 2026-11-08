import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevAuthAdapter, createDevAuthContext } from "../src/dev.js";

describe("development adapter", () => {
  it("returns a fixed context that tests can switch", async () => {
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
  });

  it("builds a context from overrides", () => {
    const context = createDevAuthContext({ role: "Editor", teacherId: "t-9" });
    expect(context.role).toBe("Editor");
    expect(context.teacherId).toBe("t-9");
    expect(context.isSuperAdmin).toBe(false);
  });
});

describe("development adapter in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses to load when NODE_ENV is production", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    await expect(import("../src/dev.js")).rejects.toThrow(/開発専用/);
  });
});
