import { describe, expect, it, vi } from "vitest";
import { AuthAccessError, type AuthContext, type Role } from "@school-manage/platform-client";
import { scheduleAction, schedulePermissions } from "../src/permissions.js";

function authWith(role: Role): AuthContext {
  return {
    userId: "p-1",
    schoolId: "school-a",
    role,
    isSuperAdmin: false,
    personId: null,
    teacherId: null,
  };
}

describe("schedule permission table", () => {
  it("carries the 4.4 roles for the data in schedule's own database", () => {
    expect(schedulePermissions).toEqual({
      "view.read": ["Admin", "Editor", "Viewer"],
      "daily.write": ["Admin", "Editor"],
      "duty.write": ["Admin", "Editor", "Viewer"],
      publish: ["Admin", "Editor"],
      "view.layout": ["Admin", "Editor"],
      "definition.write": ["Admin"],
      "school.admin": ["Admin"],
    });
  });

  it("does not hold the platform-side write permissions (implementation 1)", () => {
    const keys = Object.keys(schedulePermissions);
    expect(keys).not.toContain("event.write");
    expect(keys).not.toContain("master.write");
    expect(keys).not.toContain("import.events");
  });
});

describe("scheduleAction", () => {
  it("runs for an allowed role and refuses a lacking role with 403", async () => {
    const handler = vi.fn(() => Promise.resolve("done"));
    const action = scheduleAction("definition.write", handler);
    await expect(action.run(authWith("Admin"), null)).resolves.toBe("done");
    const error = await action.run(authWith("Editor"), null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthAccessError);
    expect(error).toMatchObject({ status: 403 });
    expect(handler.mock.calls.length).toBe(1);
  });

  it("rejects a permission name outside the table at compile time", () => {
    const declare = () =>
      scheduleAction(
        // @ts-expect-error "event.write" is the platform's, not a key of this table
        "event.write",
        () => Promise.resolve("ok"),
      );
    expect(typeof declare).toBe("function");
  });
});
