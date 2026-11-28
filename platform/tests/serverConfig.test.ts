import { describe, expect, it } from "vitest";
import { loadServerConfig } from "../src/serverConfig.js";

// Listen address resolution (Issue #132; host rule from the PR #139
// review): production must not be reachable directly from outside,
// so it binds to 127.0.0.1 unless the operator explicitly chooses
// another address. Development keeps the historical behaviour of
// listening on all interfaces.
describe("loadServerConfig", () => {
  it("applies the defaults outside production", () => {
    const config = loadServerConfig({});
    expect(config.port).toBe(3001);
    expect(config.host).toBeUndefined();
  });

  it("defaults the listen host to 127.0.0.1 in production", () => {
    const config = loadServerConfig({ NODE_ENV: "production" });
    expect(config.port).toBe(3001);
    expect(config.host).toBe("127.0.0.1");
  });

  it("lets PLATFORM_HOST override the listen host in production and development", () => {
    expect(loadServerConfig({ NODE_ENV: "production", PLATFORM_HOST: "0.0.0.0" }).host).toBe(
      "0.0.0.0",
    );
    expect(loadServerConfig({ PLATFORM_HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
  });

  it("reads PLATFORM_PORT and refuses a malformed one", () => {
    expect(loadServerConfig({ PLATFORM_PORT: "3101" }).port).toBe(3101);
    expect(() => loadServerConfig({ PLATFORM_PORT: "abc" })).toThrow(/PLATFORM_PORT/);
    expect(() => loadServerConfig({ PLATFORM_PORT: "0" })).toThrow(/PLATFORM_PORT/);
  });
});
