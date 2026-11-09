import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthAccessError } from "@school-manage/platform-client";
import { createScheduleAuth } from "../src/auth.js";

// The auth foundation (4.3 steps 1-2) against a fake platform: the
// real client is platform-client's, so these tests pin down how
// schedule wires it (product "schedule", the dev adapter's opt-in).
const PLATFORM = "http://platform.test";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const contextBody = {
  userId: "person-1",
  schoolId: "school-a",
  product: "schedule",
  role: "Editor",
  isSuperAdmin: false,
  teacherId: null,
};

afterEach(() => {
  delete process.env.PLATFORM_DEV_AUTH;
});

describe("createScheduleAuth (asking the platform)", () => {
  it("answers 401 without a session cookie, without asking the platform", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, contextBody)));
    const auth = await createScheduleAuth({ platformBaseUrl: PLATFORM, fetchImpl });
    const error = await auth.verifyRequest({ headers: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthAccessError);
    expect(error).toMatchObject({ status: 401 });
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it("passes the platform's context through for product schedule", async () => {
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      expect(String(input)).toBe(`${PLATFORM}/platform/api/v1/auth/context?product=schedule`);
      return Promise.resolve(jsonResponse(200, contextBody));
    });
    const auth = await createScheduleAuth({ platformBaseUrl: PLATFORM, fetchImpl });
    const context = await auth.verifyRequest({
      headers: { cookie: "platform_session=token-1" },
    });
    expect(context).toMatchObject({ userId: "person-1", schoolId: "school-a", role: "Editor" });
  });

  it("answers 403 when the platform refuses (no valid membership or entitlement)", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(403, { error: "権限がありません" })),
    );
    const auth = await createScheduleAuth({ platformBaseUrl: PLATFORM, fetchImpl });
    const error = await auth
      .verifyRequest({ headers: { cookie: "platform_session=token-1" } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthAccessError);
    expect(error).toMatchObject({ status: 403 });
  });
});

describe("createScheduleAuth (development adapter)", () => {
  it("stands in only under the explicit PLATFORM_DEV_AUTH=1 opt-in", async () => {
    process.env.PLATFORM_DEV_AUTH = "1";
    const auth = await createScheduleAuth({ platformBaseUrl: PLATFORM, devAuth: true });
    const context = await auth.verifyRequest({ headers: {} });
    expect(context).toMatchObject({ userId: "dev-user", schoolId: "dev-school", role: "Admin" });
  });
});
