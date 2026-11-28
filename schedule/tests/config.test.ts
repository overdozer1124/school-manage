import { describe, expect, it } from "vitest";
import { loadScheduleConfig } from "../src/config.js";

// Startup gate (Issue #132; the platform takes the same stance for
// its secrets in Issue #5): without its required environment the
// schedule server refuses to start instead of running half-wired.
describe("loadScheduleConfig", () => {
  it("refuses to load without SCHEDULE_DATABASE_URL", () => {
    expect(() => loadScheduleConfig({ PLATFORM_BASE_URL: "http://127.0.0.1:3001" })).toThrow(
      /SCHEDULE_DATABASE_URL/,
    );
  });

  it("refuses to load without PLATFORM_BASE_URL", () => {
    expect(() => loadScheduleConfig({ SCHEDULE_DATABASE_URL: "postgres://example" })).toThrow(
      /PLATFORM_BASE_URL/,
    );
  });

  it("loads with the required values and applies the defaults", () => {
    const config = loadScheduleConfig({
      SCHEDULE_DATABASE_URL: "postgres://example",
      PLATFORM_BASE_URL: "http://127.0.0.1:3001/",
    });
    expect(config.port).toBe(3002);
    expect(config.platformBaseUrl).toBe("http://127.0.0.1:3001");
    expect(config.devAuth).toBe(false);
    expect(config.publicReadServiceToken).toBeUndefined();
  });
});
