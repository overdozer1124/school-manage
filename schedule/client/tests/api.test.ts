import { describe, expect, it, vi } from "vitest";
import { ApiError, ForbiddenError, UnauthorizedError, createScheduleApi } from "../src/api";

// The API口's status handling (Issue #34, DESIGN-AUTH-TENANCY 4.8):
// 401 and 403 must stay apart — 401 sends the person to the
// platform login, 403 shows 「権限がありません」.
function fetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("schedule api client", () => {
  it("returns the parsed body on success and posts to the action endpoint", async () => {
    const fetchImpl = fetchReturning(200, { school: { id: "s1", name: "テスト学校" } });
    const api = createScheduleApi({ fetchImpl, baseUrl: "./api" });
    await expect(api.getBootstrap()).resolves.toEqual({ school: { id: "s1", name: "テスト学校" } });
    expect(fetchImpl).toHaveBeenCalledWith(
      "./api/getBootstrap",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("posts a write action to its endpoint with the input as the body (Issue #35)", async () => {
    const fetchImpl = fetchReturning(200, { record: { id: "ev-1" }, values: [] });
    const api = createScheduleApi({ fetchImpl, baseUrl: "./api" });
    await expect(api.createEvent({ event: { id: "ev-1", title: "運動会" } })).resolves.toEqual({
      record: { id: "ev-1" },
      values: [],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "./api/createEvent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ event: { id: "ev-1", title: "運動会" } }),
      }),
    );
  });

  it("throws UnauthorizedError on 401", async () => {
    const api = createScheduleApi({ fetchImpl: fetchReturning(401, { error: "認証が必要です" }) });
    await expect(api.getBootstrap()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(api.getBootstrap()).rejects.toMatchObject({ status: 401 });
  });

  it("throws ForbiddenError on 403, distinct from 401", async () => {
    const api = createScheduleApi({
      fetchImpl: fetchReturning(403, { error: "権限がありません" }),
    });
    const error = await api
      .getRange({ from: "2026-11-01", to: "2026-11-30", viewId: "v1" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).not.toBeInstanceOf(UnauthorizedError);
    expect((error as ForbiddenError).message).toBe("権限がありません");
  });

  it("throws a plain ApiError on other failures, keeping the server's message", async () => {
    const api = createScheduleApi({ fetchImpl: fetchReturning(500, { error: "内部エラー" }) });
    const error = await api.getBootstrap().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(UnauthorizedError);
    expect(error).not.toBeInstanceOf(ForbiddenError);
    expect((error as ApiError).message).toBe("内部エラー");
  });
});
