import { describe, expect, it } from "vitest";
import { afterLoginPath, safeReturnPath } from "../src/api";

// The return path after a login (Issue #129): only a path on this
// domain may be honoured. Anything that would take the freshly
// signed-in person to another site is an open redirect and is
// ignored.
describe("safeReturnPath", () => {
  it("keeps a same-domain path, query included", () => {
    expect(safeReturnPath("/school-a/schedule/")).toBe("/school-a/schedule/");
    expect(safeReturnPath("/school-a/schedule/?view=month")).toBe("/school-a/schedule/?view=month");
  });

  it("ignores an absolute URL for another domain", () => {
    expect(safeReturnPath("https://evil.example/school-a/schedule/")).toBeNull();
    expect(safeReturnPath("http://evil.example/")).toBeNull();
  });

  it("ignores a protocol-relative path", () => {
    expect(safeReturnPath("//evil.example/school-a/schedule/")).toBeNull();
  });

  it("ignores backslash tricks and non-paths", () => {
    expect(safeReturnPath("/\\evil.example/")).toBeNull();
    expect(safeReturnPath("school-a/schedule/")).toBeNull();
    expect(safeReturnPath("javascript:alert(1)")).toBeNull();
  });

  it("ignores an empty value and the login page itself", () => {
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath("")).toBeNull();
    expect(safeReturnPath("/login")).toBeNull();
    expect(safeReturnPath("/login?return=/school-a/schedule/")).toBeNull();
  });
});

describe("afterLoginPath", () => {
  const school = { schoolId: "s-a", name: "A学校", slug: "school-a" };

  it("prefers the return path", () => {
    expect(afterLoginPath("/school-b/schedule/", school)).toBe("/school-b/schedule/");
  });

  it("falls back to the chosen school's schedule page", () => {
    expect(afterLoginPath(null, school)).toBe("/school-a/schedule/");
    expect(afterLoginPath(null, { ...school, slug: null })).toBe("/");
  });
});
