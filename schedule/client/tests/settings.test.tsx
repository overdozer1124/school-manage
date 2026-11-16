import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { ScheduleApi } from "../src/api";
import { createDevApi } from "../src/devAdapter";
import type { BootstrapData } from "../src/types";

afterEach(cleanup);

// The settings screens (Issue #39): an Admin shapes the school's
// table by settings alone — DESIGN 5.2 scenario 7's path (add a
// 会議 item, put it in a view as a column) is exercised end to
// end against the development adapter, whose state the table
// behind the panel is then drawn from. The role split of
// DESIGN-AUTH-TENANCY 4.4 / 4.6 is the other half: definitions
// are Admin's, the confirmation queue is Editor-and-up's.

function withRole(api: ScheduleApi, role: string, permissions: string[]): ScheduleApi {
  return {
    ...api,
    getBootstrap: async (): Promise<BootstrapData> => {
      const bootstrap = await api.getBootstrap();
      return { ...bootstrap, role, permissions };
    },
  };
}

describe("settings screens (Issue #39)", () => {
  it("an item added in the settings can be put in a view as a column, and the table gains the column", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");

    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定" });
    const inDialog = within(dialog);

    // Add the 会議 item definition (scenario 7).
    fireEvent.click(inDialog.getByRole("button", { name: "項目を追加" }));
    fireEvent.change(inDialog.getByLabelText("項目の名前"), { target: { value: "会議" } });
    fireEvent.change(inDialog.getByLabelText("項目のキー"), { target: { value: "meeting" } });
    fireEvent.click(inDialog.getByRole("button", { name: "項目を保存" }));
    await waitFor(() => expect(inDialog.queryByText("会議")).toBeInTheDocument(), {
      timeout: 5000,
    });

    // Put it in the staff month view as a column.
    const viewRow = inDialog.getByText("職員用月表").closest("li") as HTMLElement;
    fireEvent.click(within(viewRow).getByRole("button", { name: "編集" }));
    fireEvent.change(inDialog.getByLabelText("列にする項目"), { target: { value: "" } });
    const itemSelect = inDialog.getByLabelText("列にする項目") as HTMLSelectElement;
    const meetingOption = [...itemSelect.options].find((o) => o.text === "会議");
    expect(meetingOption).toBeDefined();
    fireEvent.change(itemSelect, { target: { value: meetingOption?.value } });
    fireEvent.click(inDialog.getByRole("button", { name: "列を足す" }));
    const preview = dialog.querySelector(".settings-preview");
    expect(preview?.textContent).toContain("会議");
    fireEvent.click(inDialog.getByRole("button", { name: "ビューを保存" }));
    await waitFor(
      () =>
        expect(inDialog.queryByRole("button", { name: "ビューを保存" })).not.toBeInTheDocument(),
      { timeout: 5000 },
    );

    // Closing the panel redraws the table from the new bootstrap:
    // the 会議 column heads the month table.
    fireEvent.click(inDialog.getByRole("button", { name: "閉じる" }));
    await waitFor(
      () => {
        const head = document.querySelector(".rows-table thead");
        expect(head?.textContent).toContain("会議");
      },
      { timeout: 5000 },
    );
  });

  it("a master added through the relay shows in the masters list", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定" });
    const inDialog = within(dialog);

    fireEvent.click(inDialog.getByRole("button", { name: "教職員を追加" }));
    fireEvent.change(inDialog.getByLabelText("マスタの名前"), { target: { value: "高橋先生" } });
    fireEvent.change(inDialog.getByLabelText("略称"), { target: { value: "高橋" } });
    fireEvent.click(inDialog.getByRole("button", { name: "教職員を保存" }));
    await waitFor(() => expect(inDialog.queryByText("高橋先生")).toBeInTheDocument());
  });

  it("an Editor sees no settings button but does see the confirmation queue", async () => {
    const api = withRole(createDevApi(), "Editor", [
      "view.read",
      "daily.write",
      "duty.write",
      "publish",
      "view.layout",
      "master.write",
    ]);
    render(<App api={api} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    expect(screen.queryByRole("button", { name: "設定" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "確認待ち" })).toBeInTheDocument();
  });

  it("a Viewer sees neither the settings nor the confirmation queue", async () => {
    const api = withRole(createDevApi(), "Viewer", ["view.read", "duty.write"]);
    render(<App api={api} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    expect(screen.queryByRole("button", { name: "設定" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "確認待ち" })).not.toBeInTheDocument();
  });
});
