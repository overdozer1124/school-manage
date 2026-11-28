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

  it("ignores a path hiding a tab or newline before a second slash", () => {
    // Browsers strip tab/CR/LF out of a URL before reading it, so
    // each of these is read as "//evil.example" on navigation even
    // though the string starts with a single slash.
    expect(safeReturnPath("/\t/evil.example")).toBeNull();
    expect(safeReturnPath("/\n/evil.example")).toBeNull();
    expect(safeReturnPath("/\r/evil.example")).toBeNull();
  });

  it("ignores the percent-encoded forms as the login page receives them", () => {
    // The crafted link carries %09 / %0A / %0D; URLSearchParams
    // (what App.tsx reads the parameter with) decodes them into
    // the control characters above before safeReturnPath sees them.
    for (const encoded of ["/%09/evil.example", "/%0A/evil.example", "/%0D/evil.example"]) {
      const raw = new URLSearchParams(`return=${encoded}`).get("return");
      expect(safeReturnPath(raw)).toBeNull();
    }
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
