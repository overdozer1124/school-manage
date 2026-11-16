import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { ScheduleApi } from "../src/api";
import { createDevApi, DEV_BOOTSTRAP } from "../src/devAdapter";
import { DutyPanel } from "../src/DutyPanel";
import { columnLabel, dutyCellLines } from "../src/lib";
import type { BootstrapData, RangeData } from "../src/types";

afterEach(cleanup);

// The cell editors' write actions (Issue #35) are not exercised
// by these tests; the fakes refuse them like an unused endpoint.
const unusedWrites = {
  createEvent: async (): Promise<never> => {
    throw new Error("not used");
  },
  updateEvent: async (): Promise<never> => {
    throw new Error("not used");
  },
  deleteEvent: async (): Promise<never> => {
    throw new Error("not used");
  },
  createAbsence: async (): Promise<never> => {
    throw new Error("not used");
  },
  updateAbsence: async (): Promise<never> => {
    throw new Error("not used");
  },
  deleteAbsence: async (): Promise<never> => {
    throw new Error("not used");
  },
  setDailyValue: async (): Promise<never> => {
    throw new Error("not used");
  },
  deleteDailyValue: async (): Promise<never> => {
    throw new Error("not used");
  },
};

// Duty marks and the duty panel (Issue #38): a conflicted
// assignment carries the warning mark in the table, applying a
// change from the panel clears it, and a Viewer is offered
// operations only on their own assignments.
describe("duty marks and the panel, against the development adapter", () => {
  it("warns on the conflicted assignment, and applying a substitute clears the mark", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    await waitFor(() => {
      expect(document.querySelectorAll("tbody tr")).toHaveLength(30);
    });

    const rowOf = (date: string) =>
      document.querySelector(`tr[data-date="${date}"]`) as HTMLElement;
    // 2026-11-12: 鈴木先生 holds the day duty and is on a
    // confirmed business trip — the cell warns, in text.
    expect(rowOf("2026-11-12").textContent).toContain("鈴木先生");
    expect(rowOf("2026-11-12").textContent).toContain("⚠ 出張と重なっています");
    // 2026-11-16: 田中先生's leave is still tentative, and the
    // mark says so.
    expect(rowOf("2026-11-16").textContent).toContain("⚠ 仮の休暇と重なっています");
    // The duty column is headed by the definition's own name.
    expect(screen.getByText("日番")).toBeInTheDocument();

    // Open the panel and arrange a substitute for the trip day.
    fireEvent.click(screen.getByRole("button", { name: /当番・競合/ }));
    const dialog = await screen.findByRole("dialog", { name: "当番と競合" });
    expect(within(dialog).getByText(/11\/12（木）/)).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "交代を手配する" })[0] as HTMLElement,
    );
    // Candidates are ranked by the server (here the adapter):
    // 田中先生 first, then 佐藤先生.
    const substituteButtons = await within(dialog).findAllByRole("button", {
      name: "この回だけ代行してもらう",
    });
    expect(substituteButtons).toHaveLength(2);
    fireEvent.click(substituteButtons[0] as HTMLElement);

    // The range is read again: the cell now names 田中先生 with
    // the swapped mark, the warning is gone, and the panel's
    // conflict list no longer carries the day.
    await waitFor(() => {
      expect(rowOf("2026-11-12").textContent).toContain("田中先生");
      expect(rowOf("2026-11-12").textContent).toContain("（交代）");
      expect(rowOf("2026-11-12").textContent).not.toContain("⚠");
    });
    await waitFor(() => {
      expect(within(dialog).queryByText(/11\/12（木）/)).not.toBeInTheDocument();
    });
    // The change stands in the history as applied.
    expect(within(dialog).getByText("代行")).toBeInTheDocument();
    expect(within(dialog).getByText("適用済")).toBeInTheDocument();
  });
});

describe("the duty panel for a Viewer", () => {
  const viewerBootstrap = (): BootstrapData => {
    const bootstrap = structuredClone(DEV_BOOTSTRAP);
    bootstrap.role = "Viewer";
    bootstrap.userId = "user-viewer";
    bootstrap.teacherId = "teacher-2"; // 佐藤先生
    return bootstrap;
  };

  const assignment = (id: string, date: string, personId: string) => ({
    id,
    dutyDefinitionId: "duty-day",
    date,
    slot: "all_day",
    personId,
    targetId: null,
    origin: "auto",
    note: null,
  });

  const viewerRange = (): RangeData => {
    const view = structuredClone(DEV_BOOTSTRAP.views[0] as RangeData["view"]);
    const day = (date: string, personId: string, assignmentId: string) => ({
      date,
      day: { date, dayType: "class_day" },
      holidays: [],
      events: [],
      absences: [],
      dailyValues: [],
      dutyAssignments: [assignment(assignmentId, date, personId)],
    });
    return {
      view,
      from: "2026-11-10",
      to: "2026-11-11",
      days: [day("2026-11-10", "teacher-1", "as-other"), day("2026-11-11", "teacher-2", "as-own")],
      undecided: [],
      eventValues: [],
      conflicts: [
        {
          kind: "absence",
          assignmentId: "as-other",
          otherAssignmentId: null,
          dutyDefinitionId: "duty-day",
          dutyName: "日番",
          date: "2026-11-10",
          slot: "all_day",
          personId: "teacher-1",
          absenceId: "abs-1",
          absenceKind: "business_trip",
          certainty: "confirmed",
        },
        {
          kind: "absence",
          assignmentId: "as-own",
          otherAssignmentId: null,
          dutyDefinitionId: "duty-day",
          dutyName: "日番",
          date: "2026-11-11",
          slot: "all_day",
          personId: "teacher-2",
          absenceId: "abs-2",
          absenceKind: "leave",
          certainty: "confirmed",
        },
      ],
    };
  };

  const fakeApi = () => {
    const proposed = {
      id: "change-1",
      dutyDefinitionId: "duty-day",
      kind: "substitute" as const,
      assignmentAId: "as-own",
      assignmentBId: null,
      fromPersonId: "teacher-2",
      toPersonId: "teacher-3",
      reason: "",
      requestedBy: "user-viewer",
      approvedBy: null,
      status: "proposed" as const,
      createdAt: "2026-11-10T00:00:00.000Z",
      appliedAt: null,
    };
    const api: ScheduleApi = {
      ...unusedWrites,
      getBootstrap: async () => viewerBootstrap(),
      getRange: async () => viewerRange(),
      previewRotation: async () => [],
      applyRotation: async () => ({ created: 0, updated: 0, skipped: 0, assignments: [] }),
      proposeDutyChange: vi.fn(async () => proposed),
      applyDutyChange: vi.fn(async () => ({ ...proposed, status: "applied" as const })),
      declineDutyChange: vi.fn(async () => ({ ...proposed, status: "declined" as const })),
      getDutyChanges: async () => [],
      getDutyConflicts: async () => [],
      waiveConflict: vi.fn(async () => ({ waived: true })),
      getDutyChangeCandidates: async () => ["teacher-3"],
    };
    return api;
  };

  it("offers operations only on the Viewer's own assignment, and only as proposals", async () => {
    const api = fakeApi();
    render(
      <DutyPanel
        bootstrap={viewerBootstrap()}
        range={viewerRange()}
        api={api}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );
    // Both conflicts are listed — reading is not the restriction.
    expect(screen.getByText(/田中先生/)).toBeInTheDocument();
    expect(screen.getByText(/佐藤先生/)).toBeInTheDocument();
    // But the arrange button exists only for 佐藤先生's own
    // assignment (2026-11-11), not for 田中先生's.
    const arrangeButtons = screen.getAllByRole("button", { name: "交代を手配する" });
    expect(arrangeButtons).toHaveLength(1);

    fireEvent.click(arrangeButtons[0] as HTMLElement);
    // The candidate's action is a proposal, in the Viewer's words.
    const proposeButton = await screen.findByRole("button", {
      name: "この回だけ代行を申し出る",
    });
    expect(
      screen.queryByRole("button", { name: "この回だけ代行してもらう" }),
    ).not.toBeInTheDocument();
    // No waiving for a Viewer, and no rotation apply.
    expect(screen.queryByPlaceholderText(/このままにする理由/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /この内容で割り当てる/ })).not.toBeInTheDocument();

    fireEvent.click(proposeButton);
    await waitFor(() => {
      expect(api.proposeDutyChange).toHaveBeenCalledTimes(1);
    });
    expect(api.proposeDutyChange).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "substitute",
        assignmentAId: "as-own",
        toPersonId: "teacher-3",
      }),
    );
    // A proposal is all that happened: nothing was applied, and
    // the panel says the change waits for an editor.
    expect(api.applyDutyChange).not.toHaveBeenCalled();
    expect(await screen.findByText(/交代を申し出しました/)).toBeInTheDocument();
  });
});

describe("the rotation preview in the panel", () => {
  it("discards the preview when the period changes, so unpreviewed days are never applied", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(await screen.findByRole("button", { name: /当番・競合/ }));
    const dialog = await screen.findByRole("dialog", { name: "当番と競合" });

    fireEvent.click(within(dialog).getByRole("button", { name: "プレビュー" }));
    expect(
      await within(dialog).findByRole("button", { name: /この内容で割り当てる/ }),
    ).toBeInTheDocument();

    // Change the end of the period: the standing preview no
    // longer matches the conditions on screen, so the apply
    // button goes away until the new period is previewed.
    fireEvent.change(within(dialog).getByLabelText("生成終了日"), {
      target: { value: "2026-12-31" },
    });
    expect(
      within(dialog).queryByRole("button", { name: /この内容で割り当てる/ }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/（新規）|（入れ替え）/)).not.toBeInTheDocument();
  });
});

describe("the duty panel when applying a proposal fails", () => {
  it("says the proposal stands and shows it in the history", async () => {
    const bootstrap = structuredClone(DEV_BOOTSTRAP);
    bootstrap.role = "Editor";
    const proposedChange = {
      id: "change-1",
      dutyDefinitionId: "duty-day",
      kind: "substitute" as const,
      assignmentAId: "as-1",
      assignmentBId: null,
      fromPersonId: "teacher-3",
      toPersonId: "teacher-2",
      reason: "",
      requestedBy: "dev-user",
      approvedBy: null,
      status: "proposed" as const,
      createdAt: "2026-11-10T00:00:00.000Z",
      appliedAt: null,
    };
    let proposed = false;
    const api: ScheduleApi = {
      ...unusedWrites,
      getBootstrap: async () => bootstrap,
      getRange: async () => {
        throw new Error("not used");
      },
      previewRotation: async () => [],
      applyRotation: async () => ({ created: 0, updated: 0, skipped: 0, assignments: [] }),
      proposeDutyChange: vi.fn(async () => {
        proposed = true;
        return proposedChange;
      }),
      applyDutyChange: vi.fn(async () => {
        throw new Error("ほかの先生が先に変更しました");
      }),
      declineDutyChange: vi.fn(async () => ({ ...proposedChange, status: "declined" as const })),
      getDutyChanges: vi.fn(async () => (proposed ? [proposedChange] : [])),
      getDutyConflicts: async () => [],
      waiveConflict: vi.fn(async () => ({ waived: true })),
      getDutyChangeCandidates: async () => ["teacher-2"],
    };
    const range: RangeData = {
      view: structuredClone(DEV_BOOTSTRAP.views[0] as RangeData["view"]),
      from: "2026-11-10",
      to: "2026-11-10",
      days: [
        {
          date: "2026-11-10",
          day: { date: "2026-11-10", dayType: "class_day" },
          holidays: [],
          events: [],
          absences: [],
          dailyValues: [],
          dutyAssignments: [
            {
              id: "as-1",
              dutyDefinitionId: "duty-day",
              date: "2026-11-10",
              slot: "all_day",
              personId: "teacher-3",
              targetId: null,
              origin: "auto",
              note: null,
            },
          ],
        },
      ],
      undecided: [],
      eventValues: [],
      conflicts: [
        {
          kind: "absence",
          assignmentId: "as-1",
          otherAssignmentId: null,
          dutyDefinitionId: "duty-day",
          dutyName: "日番",
          date: "2026-11-10",
          slot: "all_day",
          personId: "teacher-3",
          absenceId: "abs-1",
          absenceKind: "business_trip",
          certainty: "confirmed",
        },
      ],
    };
    render(
      <DutyPanel
        bootstrap={bootstrap}
        range={range}
        api={api}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "交代を手配する" }));
    fireEvent.click(await screen.findByRole("button", { name: "この回だけ代行してもらう" }));

    // The message names what happened: the proposal was recorded,
    // the apply failed, and the retry lives in the history.
    expect(
      await screen.findByText(
        "申し出は記録されました。適用できなかったので、履歴から適用し直してください。",
      ),
    ).toBeInTheDocument();
    expect(api.proposeDutyChange).toHaveBeenCalledTimes(1);
    expect(api.applyDutyChange).toHaveBeenCalledTimes(1);
    // The history was re-read after the failure (initial load plus
    // the finally), so the standing proposal shows there — with
    // its apply button — instead of inviting a second proposal.
    await waitFor(() => {
      expect(api.getDutyChanges).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("提案中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "適用する" })).toBeInTheDocument();
  });
});

describe("the rotation period follows the displayed range", () => {
  it("resets the draft period and drops the preview when the range changes", async () => {
    const bootstrap = structuredClone(DEV_BOOTSTRAP);
    const api: ScheduleApi = {
      ...unusedWrites,
      getBootstrap: async () => bootstrap,
      getRange: async () => {
        throw new Error("not used");
      },
      previewRotation: async () => [
        {
          date: "2026-11-05",
          slot: "all_day",
          personId: "teacher-1",
          action: "create" as const,
          existing: null,
        },
      ],
      applyRotation: async () => ({ created: 0, updated: 0, skipped: 0, assignments: [] }),
      proposeDutyChange: vi.fn(async () => {
        throw new Error("not used");
      }),
      applyDutyChange: vi.fn(async () => {
        throw new Error("not used");
      }),
      declineDutyChange: vi.fn(async () => {
        throw new Error("not used");
      }),
      getDutyChanges: async () => [],
      getDutyConflicts: async () => [],
      waiveConflict: vi.fn(async () => ({ waived: true })),
      getDutyChangeCandidates: async () => [],
    };
    const rangeFor = (from: string, to: string): RangeData => ({
      view: structuredClone(DEV_BOOTSTRAP.views[0] as RangeData["view"]),
      from,
      to,
      days: [],
      undecided: [],
      eventValues: [],
      conflicts: [],
    });
    const { rerender } = render(
      <DutyPanel
        bootstrap={bootstrap}
        range={rangeFor("2026-11-01", "2026-11-30")}
        api={api}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "プレビュー" }));
    expect(await screen.findByRole("button", { name: /この内容で割り当てる/ })).toBeInTheDocument();

    rerender(
      <DutyPanel
        bootstrap={bootstrap}
        range={rangeFor("2026-12-01", "2026-12-31")}
        api={api}
        onClose={() => {}}
        onChanged={() => {}}
      />,
    );
    expect((screen.getByLabelText("生成開始日") as HTMLInputElement).value).toBe("2026-12-01");
    expect((screen.getByLabelText("生成終了日") as HTMLInputElement).value).toBe("2026-12-31");
    expect(screen.queryByRole("button", { name: /この内容で割り当てる/ })).not.toBeInTheDocument();
  });
});

describe("duty cell lines (pure)", () => {
  const bootstrap = structuredClone(DEV_BOOTSTRAP);
  const column = (DEV_BOOTSTRAP.views[0]?.columns.find((c) => c.sourceKind === "duty") ??
    DEV_BOOTSTRAP.views[0]?.columns[0]) as NonNullable<
    (typeof DEV_BOOTSTRAP.views)[0]
  >["columns"][number];

  it("names the duty column after its definition", () => {
    expect(columnLabel(column, bootstrap)).toBe("日番");
  });

  it("marks a swapped assignment and a tentative-absence conflict in text", () => {
    const day = {
      date: "2026-11-16",
      day: {},
      holidays: [],
      events: [],
      absences: [],
      dailyValues: [],
      dutyAssignments: [
        {
          id: "as-1",
          dutyDefinitionId: "duty-day",
          date: "2026-11-16",
          slot: "all_day",
          personId: "teacher-1",
          targetId: null,
          origin: "swap",
          note: null,
        },
      ],
    };
    const lines = dutyCellLines(day, column, bootstrap, [
      {
        kind: "absence",
        assignmentId: "as-1",
        otherAssignmentId: null,
        dutyDefinitionId: "duty-day",
        dutyName: "日番",
        date: "2026-11-16",
        slot: "all_day",
        personId: "teacher-1",
        absenceId: "abs-2",
        absenceKind: "leave",
        certainty: "tentative",
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("田中先生");
    expect(lines[0]?.swapped).toBe(true);
    expect(lines[0]?.warning).toBe("仮の休暇と重なっています");
  });

  it("stands an unassigned applicable cell as its own warned line", () => {
    const day = {
      date: "2026-11-17",
      day: {},
      holidays: [],
      events: [],
      absences: [],
      dailyValues: [],
      dutyAssignments: [],
    };
    const lines = dutyCellLines(day, column, bootstrap, [
      {
        kind: "unassigned",
        assignmentId: null,
        otherAssignmentId: null,
        dutyDefinitionId: "duty-day",
        dutyName: "日番",
        date: "2026-11-17",
        slot: "all_day",
        personId: null,
        absenceId: null,
        absenceKind: null,
        certainty: null,
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.warning).toBe("未割当です");
  });
});
