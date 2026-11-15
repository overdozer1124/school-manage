import { describe, expect, it } from "vitest";
import { devAdapterEnabled } from "../src/devAdapter";

// The development adapter switch (PR #73 review): `?dev=1` may
// switch a development build to the fixture data, but a production
// build must never switch from the URL alone. The build-time env
// flag stays an explicit opt-in either way.
describe("devAdapterEnabled", () => {
  it("honors ?dev=1 in a development build", () => {
    expect(devAdapterEnabled("?dev=1", undefined, true)).toBe(true);
  });

  it("ignores ?dev=1 in a production build", () => {
    expect(devAdapterEnabled("?dev=1", undefined, false)).toBe(false);
  });

  it("honors the build-time env flag in either build", () => {
    expect(devAdapterEnabled("", "1", false)).toBe(true);
    expect(devAdapterEnabled("", "1", true)).toBe(true);
  });

  it("stays off without any opt-in", () => {
    expect(devAdapterEnabled("", undefined, true)).toBe(false);
    expect(devAdapterEnabled("?dev=0", undefined, true)).toBe(false);
  });
});
