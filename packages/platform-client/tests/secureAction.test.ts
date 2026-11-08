import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  AuthAccessError,
  defineActions,
  publicAction,
  secureAction,
  type AuthContext,
  type PermissionTable,
  type Role,
} from "../src/index.js";

const permissions: PermissionTable = {
  "view.read": ["Admin", "Editor", "Viewer"],
  "event.write": ["Admin", "Editor"],
  "school.admin": ["Admin"],
};

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

describe("secureAction", () => {
  it("runs the handler when the role is allowed", async () => {
    const handler = vi.fn(({ auth, request }: { auth: AuthContext; request: string }) =>
      Promise.resolve(`${auth.role}:${request}`),
    );
    const action = secureAction({ permission: "event.write", permissions, handler });
    await expect(action.run(authWith("Editor"), "input")).resolves.toBe("Editor:input");
    expect(handler.mock.calls.length).toBe(1);
  });

  it("refuses with 403 when the role is not allowed, without running the handler", async () => {
    const handler = vi.fn(() => Promise.resolve("ok"));
    const action = secureAction({ permission: "event.write", permissions, handler });
    const error = await action.run(authWith("Viewer"), null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthAccessError);
    expect(error).toMatchObject({ status: 403 });
    expect(handler.mock.calls.length).toBe(0);
  });

  it("refuses a permission missing from the table", async () => {
    const action = secureAction({
      permission: "unknown.permission",
      permissions,
      handler: () => Promise.resolve("ok"),
    });
    await expect(action.run(authWith("Admin"), null)).rejects.toMatchObject({ status: 403 });
  });

  it("public actions run without an AuthContext", async () => {
    const action = publicAction(({ request }: { request: number }) => Promise.resolve(request * 2));
    await expect(action.run(21)).resolves.toBe(42);
  });
});

describe("action types (checked by tsc)", () => {
  it("keeps AuthContext aligned with the design", () => {
    expectTypeOf<AuthContext["role"]>().toEqualTypeOf<Role>();
    expectTypeOf<AuthContext["personId"]>().toEqualTypeOf<number | null>();
  });

  it("accepts a registry of secure and public actions", () => {
    const actions = defineActions({
      getRange: secureAction({
        permission: "view.read",
        permissions,
        handler: () => Promise.resolve(1),
      }),
      getPublicRange: publicAction(() => Promise.resolve(2)),
    });
    expectTypeOf(actions.getRange.kind).toEqualTypeOf<"secure">();
    expectTypeOf(actions.getPublicRange.kind).toEqualTypeOf<"public">();
  });

  it("rejects declarations that skip the guard", () => {
    // @ts-expect-error a secure action must declare its permission
    secureAction({ permissions, handler: () => Promise.resolve(1) });

    defineActions({
      // @ts-expect-error a bare handler is neither a SecureAction nor a PublicAction
      bare: { run: () => Promise.resolve(1) },
    });
  });
});
