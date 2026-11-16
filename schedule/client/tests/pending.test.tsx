import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { createDevApi } from "../src/devAdapter";
import { pendingRange, schoolYearOf } from "../src/lib";

afterEach(cleanup);

// The confirmation queue (Issue #39, DESIGN-AUTH-TENANCY 4.6):
// tentative absences and events are settled by confirming or
// deleting — nothing else. The fixture school carries one
// tentative trip and Issue #35's two provisional entries (a
// placeholder name and a title-only trip), so both halves of
// the queue are exercised, provisionals included.

describe("confirmation queue (Issue #39)", () => {
  it("lists tentative absences and provisional events, and settles them by confirm or delete", async () => {
    const api = createDevApi();
    render(<App api={api} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");

    fireEvent.click(screen.getByRole("button", { name: "確認待ち" }));
    const dialog = await screen.findByRole("dialog", { name: "確認待ち" });
    const inDialog = within(dialog);

    // The tentative trip (absence) and the two provisionals.
    expect(await inDialog.findByText(/市教研研修会/)).toBeInTheDocument();
    expect(inDialog.getByText(/生徒指導担当者部会/)).toBeInTheDocument();
    expect(inDialog.getAllByText(/仮の予定：出張の担当が未確定です/)).toHaveLength(2);

    // Confirm the absence: it leaves the queue, confirmed.
    const absenceRow = inDialog.getByText(/市教研研修会/).closest("li") as HTMLElement;
    fireEvent.click(within(absenceRow).getByRole("button", { name: "確定" }));
    await waitFor(() => expect(inDialog.queryByText(/市教研研修会/)).not.toBeInTheDocument());
    expect((await api.getPendingAbsences()).items).toHaveLength(0);

    // Delete one provisional event: it leaves the queue, gone.
    const eventRow = inDialog.getByText(/生徒指導担当者部会/).closest("li") as HTMLElement;
    fireEvent.click(within(eventRow).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(inDialog.queryByText(/生徒指導担当者部会/)).not.toBeInTheDocument());
    const remaining = (await api.getPendingEvents({ from: "2025-04-01", to: "2028-03-31" })).items;
    expect(remaining.map((r) => r["id"])).toEqual(["ev-provisional-name"]);

    // Confirm the last provisional: the queue empties.
    const lastRow = inDialog.getByText(/生徒指導担当/).closest("li") as HTMLElement;
    fireEvent.click(within(lastRow).getByRole("button", { name: "確定" }));
    expect(await inDialog.findByText("確認待ちはありません。")).toBeInTheDocument();
  });

  it("the pending window covers whole school years around today", () => {
    expect(schoolYearOf("2026-11-16")).toBe(2026);
    expect(schoolYearOf("2027-02-01")).toBe(2026);
    expect(pendingRange("2026-11-16")).toEqual({ from: "2025-04-01", to: "2028-03-31" });
    expect(pendingRange("2027-02-01")).toEqual({ from: "2025-04-01", to: "2028-03-31" });
  });
});
