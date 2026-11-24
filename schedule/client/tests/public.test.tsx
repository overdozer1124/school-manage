import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PublicApp } from "../src/PublicApp";
import { ApiError, UnauthorizedError, type PublicApi } from "../src/api";
import { createDevPublicApi } from "../src/devAdapter";
import type { PublicBootstrapData, PublicRangeData } from "../src/types";

afterEach(cleanup);

// Public viewing (Issue #41): the token's page renders the one
// view it was issued for, read-only — the month table's display
// components with no editor anywhere — and a token that cannot
// be used gets a plain "this URL cannot be used" face, never a
// sign-in prompt (there is no account behind a public URL).

const VIEW = {
  id: "view-guardian",
  name: "保護者用月表",
  layout: "month_rows",
  layoutParams: null,
  audience: "guardian",
  periodScope: "month",
  printSettings: null,
  isArchived: false,
  columns: [
    {
      id: "col-events",
      viewDefinitionId: "view-guardian",
      sourceKind: "event_category" as const,
      itemDefinitionId: null,
      dutyDefinitionId: null,
      targetGroupId: null,
      groupSameValues: true,
      widthHint: null,
      sort: 1,
    },
    {
      id: "col-lunch",
      viewDefinitionId: "view-guardian",
      sourceKind: "daily_item" as const,
      itemDefinitionId: "item-lunch",
      dutyDefinitionId: null,
      targetGroupId: null,
      groupSameValues: true,
      widthHint: null,
      sort: 2,
    },
  ],
};

const BOOT: PublicBootstrapData = {
  school: { id: "school-1", name: "テスト学校" },
  view: VIEW,
  itemDefinitions: [
    {
      id: "item-lunch",
      key: "lunch",
      name: "給食",
      valueType: "symbol",
      targetGroupId: null,
      targetPlatformAxis: null,
      granularity: "day",
      defaultVisibility: "guardian",
      sort: 1,
      isActive: true,
      options: [
        { id: "opt-yes", code: "yes", label: "○", sort: 1 },
        { id: "opt-no", code: "no", label: "×", sort: 2 },
      ],
    },
  ],
  targetGroups: [],
  grades: [],
  holidays: [],
};

const RANGE: PublicRangeData = {
  view: VIEW,
  from: "2026-11-01",
  to: "2026-11-30",
  days: [
    {
      date: "2026-11-06",
      day: {
        date: "2026-11-06",
        dayType: "class_day",
        dayTypeLabel: null,
        dayScheduleId: null,
        weekdaySwap: null,
        note: null,
        source: "default",
      },
      holidays: [],
      events: [
        {
          id: "ev-1",
          kind: "event",
          kindLabel: null,
          title: "運動会",
          datePrecision: "day",
          startsOn: "2026-11-06",
          endsOn: "2026-11-06",
          time: null,
          certainty: "confirmed",
          visibility: "guardian",
          assignees: [],
        },
      ],
      absences: [],
      dailyValues: [],
      dutyAssignments: [],
    },
  ],
  undecided: [],
  eventValues: [],
  conflicts: [],
  monthNotes: [],
  latestPublication: null,
};

function fakeApi(overrides: Partial<PublicApi> = {}): PublicApi {
  return {
    getPublicBootstrap: async () => structuredClone(BOOT),
    getPublicRange: async () => structuredClone(RANGE),
    ...overrides,
  };
}

describe("public viewing screen (Issue #41)", () => {
  it("renders the view's month table with no way to write", async () => {
    render(<PublicApp api={fakeApi()} />);
    expect(await screen.findByText("テスト学校 行事予定")).toBeInTheDocument();
    expect(await screen.findByText("運動会")).toBeInTheDocument();
    // No input components, and none of the signed-in chrome:
    // no settings, no duty panel, no publish controls.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "設定" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "当番・交代" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "発行・印刷" })).not.toBeInTheDocument();
  });

  it("a revoked token's page says the URL cannot be used", async () => {
    render(
      <PublicApp
        api={fakeApi({
          getPublicBootstrap: async () => {
            throw new UnauthorizedError("この公開URLは無効化されています");
          },
        })}
      />,
    );
    expect(await screen.findByText("この公開URLは使えません")).toBeInTheDocument();
    expect(screen.getByText("この公開URLは無効化されています")).toBeInTheDocument();
    expect(screen.queryByText("ログイン")).not.toBeInTheDocument();
  });

  it("a 503 is a 'not available now' face, not the dead URL's", async () => {
    // The server answers 503 when it cannot serve the page
    // itself (Issue #82 review): the reader is asked to come
    // back later, not told their URL cannot be used.
    render(
      <PublicApp
        api={fakeApi({
          getPublicBootstrap: async () => {
            throw new ApiError(503, "ただいま表示できません");
          },
        })}
      />,
    );
    expect(await screen.findByText("ただいま表示できません")).toBeInTheDocument();
    expect(screen.queryByText("この公開URLは使えません")).not.toBeInTheDocument();
  });

  it("announces the month's latest version when the range carries one (Issue #48)", async () => {
    render(
      <PublicApp
        api={fakeApi({
          getPublicRange: async () => ({
            ...structuredClone(RANGE),
            latestPublication: {
              versionLabel: "11月18日修正",
              publishedAt: "2026-11-18T09:00:00.000Z",
            },
          }),
        })}
      />,
    );
    expect(
      await screen.findByText(/この月の最新版は 11月18日修正（2026年11月18日 発行）です/),
    ).toBeInTheDocument();
  });

  it("shows no latest-version notice when the month has none (Issue #48)", async () => {
    render(<PublicApp api={fakeApi()} />);
    expect(await screen.findByText("運動会")).toBeInTheDocument();
    expect(screen.queryByText(/この月の最新版は/)).not.toBeInTheDocument();
  });

  it("the dev public adapter answers the fixture token with a staff-free bundle", async () => {
    const api = createDevPublicApi("dev-public-token");
    const boot = await api.getPublicBootstrap();
    expect(boot.view.id).toBe("view-month-guardian");
    const range = await api.getPublicRange({ from: "2026-11-01", to: "2026-11-30" });
    const text = JSON.stringify(range);
    expect(text).toContain("授業参観");
    expect(text).not.toContain("先生");
    for (const day of range.days) {
      expect(day.absences).toEqual([]);
      expect(day.dutyAssignments).toEqual([]);
    }
    expect(range.conflicts).toEqual([]);
    // The guardian view has no issued versions in the fixture:
    // the latest-version notice (Issue #48) is null, not absent.
    expect(range.latestPublication).toBeNull();
  });

  it("the dev public adapter refuses an unknown token", async () => {
    const api = createDevPublicApi("no-such-token");
    await expect(api.getPublicBootstrap()).rejects.toMatchObject({ status: 404 });
  });
});
