import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ForbiddenError, UnauthorizedError, type ScheduleApi } from "../src/api";
import { createDevApi } from "../src/devAdapter";

// Screen tests (Issue #34): the L1 month table and the L2 week
// table drawn from the development adapter's preset data, the view
// switch and period movement, and the 401 / 403 handling of
// DESIGN-AUTH-TENANCY 4.8.
describe("schedule screen with the development adapter", () => {
  it("draws the L1 month table for November 2026 from the bus preset", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    // The month's rows: one per day, in date order.
    expect(await screen.findByText("開発用小学校")).toBeInTheDocument();
    expect(screen.getByText("2026年11月")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll("tbody tr")).toHaveLength(30);
    });
    const rows = document.querySelectorAll("tbody tr");
    expect(rows[0]?.getAttribute("data-date")).toBe("2026-11-01");
    expect(rows[29]?.getAttribute("data-date")).toBe("2026-11-30");
    // Preset columns and sample content.
    expect(screen.getByText("スクールバス")).toBeInTheDocument();
    expect(screen.getByText("授業参観")).toBeInTheDocument();
    expect(screen.getAllByText("1～3年 14:30／4～6年 15:20").length).toBeGreaterThan(0);
    // The holiday is named in text, not only coloured.
    expect(screen.getByText(/文化の日/)).toBeInTheDocument();
    // The undecided section shows this month's and the year's.
    expect(screen.getByText("その月の未定")).toBeInTheDocument();
    expect(screen.getByText("作品展")).toBeInTheDocument();
    expect(screen.getByText("研究発表会")).toBeInTheDocument();
  });

  it("switches to the L2 two-week table and moves by weeks", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "view-week-staff" } });
    await waitFor(() => {
      expect(document.querySelectorAll("tbody tr")).toHaveLength(14);
    });
    expect(screen.getByText("2026-11-09 〜 2026-11-22")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    await waitFor(() => {
      expect(screen.getByText("2026-11-23 〜 2026-12-06")).toBeInTheDocument();
    });
    expect(document.querySelectorAll("tbody tr")).toHaveLength(14);
  });

  it("does not offer an archived view in the switcher, and opens on the first listed view", async () => {
    const api = createDevApi();
    await api.setViewArchived({ id: "view-month-staff", archived: true });
    render(<App api={api} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    const select = screen.getByLabelText("ビュー") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "職員用週表（2週間）",
      "保護者用月表",
      "職員用年間表",
      "職員用カレンダー",
      "職員用タイムライン",
      "職員用タイムライン（時限）",
    ]);
    expect(select.value).toBe("view-week-staff");
    // The two-week table is what opens.
    await waitFor(() => {
      expect(document.querySelectorAll("tbody tr")).toHaveLength(14);
    });
  });

  it("moves by months in the L1 view", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "次へ" }));
    expect(await screen.findByText("2026年12月")).toBeInTheDocument();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(31);
  });
});

describe("401 / 403 handling", () => {
  const failingApi = (error: Error): ScheduleApi => {
    const fail = async (): Promise<never> => {
      throw error;
    };
    return {
      getBootstrap: fail,
      getRange: fail,
      createEvent: fail,
      updateEvent: fail,
      deleteEvent: fail,
      createAbsence: fail,
      updateAbsence: fail,
      deleteAbsence: fail,
      setDailyValue: fail,
      deleteDailyValue: fail,
      getEventValues: fail,
      setEventValues: fail,
      previewRotation: fail,
      applyRotation: fail,
      proposeDutyChange: fail,
      applyDutyChange: fail,
      declineDutyChange: fail,
      getDutyChanges: fail,
      getDutyConflicts: fail,
      waiveConflict: fail,
      getDutyChangeCandidates: fail,
      getDefinitions: fail,
      upsertItemDefinition: fail,
      deleteItemDefinition: fail,
      upsertTargetGroup: fail,
      deleteTargetGroup: fail,
      upsertTarget: fail,
      deleteTarget: fail,
      upsertLocation: fail,
      deleteLocation: fail,
      saveSettings: fail,
      applyPreset: fail,
      upsertViewDefinition: fail,
      deleteViewDefinition: fail,
      setViewArchived: fail,
      upsertDutyDefinition: fail,
      deleteDutyDefinition: fail,
      upsertKindTemplate: fail,
      deleteKindTemplate: fail,
      applyDefaultKindTemplates: fail,
      getMasters: fail,
      createMaster: fail,
      updateMaster: fail,
      deleteMaster: fail,
      getPendingAbsences: fail,
      confirmAbsence: fail,
      getPendingEvents: fail,
      confirmEvent: fail,
      createPublication: fail,
      getPublications: fail,
      getPublication: fail,
      createPublicViewToken: fail,
      getPublicViewTokens: fail,
      revokePublicViewToken: fail,
      getSubdivisions: fail,
      createSubdivision: fail,
      updateSubdivision: fail,
      deleteSubdivision: fail,
      applyDefaultSubdivisions: fail,
    };
  };

  it("a 401 hands off to the platform login instead of showing the table", async () => {
    const onUnauthorized = vi.fn();
    render(<App api={failingApi(new UnauthorizedError())} onUnauthorized={onUnauthorized} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("権限がありません")).not.toBeInTheDocument();
  });

  it("a 403 shows 「権限がありません」 and does not hand off to the login", async () => {
    const onUnauthorized = vi.fn();
    render(<App api={failingApi(new ForbiddenError())} onUnauthorized={onUnauthorized} />);
    expect(await screen.findByText("権限がありません")).toBeInTheDocument();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
