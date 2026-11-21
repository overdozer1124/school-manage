import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { ScheduleApi } from "../src/api";
import { createDevApi } from "../src/devAdapter";
import { formatIssuedAt } from "../src/lib";
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
  // This scenario renders the whole settings panel several times
  // over; the client config's testTimeout already allows 20s, and
  // the explicit limit here keeps the intent visible (PR #78
  // re-review, required 1).
  it("an item added in the settings can be put in a view as a column, and the table gains the column", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");

    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
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
  }, 20000);

  it("a new item's visibility defaults to staff only, and editing keeps the item's own value", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
    const inDialog = within(dialog);

    // New item: the default is closed — staff only (DESIGN 9).
    fireEvent.click(inDialog.getByRole("button", { name: "項目を追加" }));
    expect((inDialog.getByLabelText("公開範囲") as HTMLSelectElement).value).toBe("staff_only");
    fireEvent.click(inDialog.getByRole("button", { name: "やめる" }));

    // Editing an existing item shows that item's own value
    // (行事 is guardian in the fixture), not the new-item default.
    const eventsRow = inDialog.getByText(/events／/).closest("li") as HTMLElement;
    fireEvent.click(within(eventsRow).getByRole("button", { name: "編集" }));
    expect((inDialog.getByLabelText("公開範囲") as HTMLSelectElement).value).toBe("guardian");
    fireEvent.click(inDialog.getByRole("button", { name: "やめる" }));

    // And an existing staff-only item stays staff only.
    const cleaningRow = inDialog.getByText(/cleaning／/).closest("li") as HTMLElement;
    fireEvent.click(within(cleaningRow).getByRole("button", { name: "編集" }));
    expect((inDialog.getByLabelText("公開範囲") as HTMLSelectElement).value).toBe("staff_only");
  }, 20000);

  it("arming an item or duty delete spells out what disappears with it", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
    const inDialog = within(dialog);

    // Item definition: its daily values, event values and legend
    // cascade away for every school year; stopping (isActive) is
    // offered as the non-destructive alternative.
    const eventsRow = inDialog.getByText(/events／/).closest("li") as HTMLElement;
    fireEvent.click(within(eventsRow).getByRole("button", { name: "削除" }));
    expect(within(eventsRow).getByRole("button", { name: "本当に削除" })).toBeInTheDocument();
    expect(
      inDialog.getByText(/日次値・行事の追加項目・凡例が全年度分すべて消えます/),
    ).toBeInTheDocument();
    expect(inDialog.getByText(/「使用中」のチェックを外して停止してください/)).toBeInTheDocument();

    // Duty definition: assignments, the change history and the
    // waivers cascade away for every school year; stopping
    // (isActive, Issue #86) is the alternative, spelled out in
    // the same shape as the item definition's wording. (Arming
    // this delete disarms the item's above, so the guidance is
    // asserted again here.)
    const dutyRow = inDialog.getByText(/通年／輪番/).closest("li") as HTMLElement;
    fireEvent.click(within(dutyRow).getByRole("button", { name: "削除" }));
    expect(within(dutyRow).getByRole("button", { name: "本当に削除" })).toBeInTheDocument();
    expect(
      inDialog.getByText(/割当・交代の履歴・見送りの記録が全年度分すべて消えます/),
    ).toBeInTheDocument();
    expect(inDialog.getByText(/「使用中」のチェックを外して停止してください/)).toBeInTheDocument();
  }, 20000);

  it("a duty stopped in the settings shows as stopped, and resuming clears the mark", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
    const inDialog = within(dialog);

    // Stop 日番 through the edit form's 使用中 checkbox (the
    // same shape as item definitions and locations).
    const dutyRow = () => inDialog.getByText(/通年／輪番/).closest("li") as HTMLElement;
    fireEvent.click(within(dutyRow()).getByRole("button", { name: "編集" }));
    const activeBox = inDialog.getByLabelText("使用中") as HTMLInputElement;
    expect(activeBox.checked).toBe(true);
    fireEvent.click(activeBox);
    fireEvent.click(inDialog.getByRole("button", { name: "当番を保存" }));
    await waitFor(() => expect(within(dutyRow()).getByText(/停止中/)).toBeInTheDocument(), {
      timeout: 5000,
    });

    // Resume it: the mark goes away.
    fireEvent.click(within(dutyRow()).getByRole("button", { name: "編集" }));
    const stoppedBox = inDialog.getByLabelText("使用中") as HTMLInputElement;
    expect(stoppedBox.checked).toBe(false);
    fireEvent.click(stoppedBox);
    fireEvent.click(inDialog.getByRole("button", { name: "当番を保存" }));
    await waitFor(() => expect(within(dutyRow()).queryByText(/停止中/)).not.toBeInTheDocument(), {
      timeout: 5000,
    });
  }, 20000);

  it("a view taken off the list leaves the settings list and the switcher, and comes back whole", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
    const inDialog = within(dialog);

    const guardianRow = () => inDialog.getByText("保護者用月表").closest("li") as HTMLElement;
    const staffRow = () => inDialog.getByText("職員用月表").closest("li") as HTMLElement;

    // Arming the view's delete spells out what disappears with
    // it, that a view with issued publications cannot be
    // deleted at all, and that archiving (Issue #87) is the
    // non-destructive way to retire it. (Arming the staff view's
    // delete afterwards disarms this one without deleting.)
    fireEvent.click(within(guardianRow()).getByRole("button", { name: "削除" }));
    expect(within(guardianRow()).getByRole("button", { name: "本当に削除" })).toBeInTheDocument();
    expect(inDialog.getByText(/列の定義と公開URLの記録もすべて消えます/)).toBeInTheDocument();
    expect(inDialog.getByText(/発行した版があるビューは削除できません/)).toBeInTheDocument();
    expect(inDialog.getByText(/「一覧から外す」を使ってください/)).toBeInTheDocument();
    fireEvent.click(within(staffRow()).getByRole("button", { name: "削除" }));

    // Take the guardian view off the list: it leaves the
    // everyday list at once.
    fireEvent.click(within(guardianRow()).getByRole("button", { name: "一覧から外す" }));
    await waitFor(() => expect(inDialog.queryByText("保護者用月表")).not.toBeInTheDocument(), {
      timeout: 5000,
    });

    // Behind the panel, the switcher no longer offers it either.
    fireEvent.click(inDialog.getByRole("button", { name: "閉じる" }));
    await waitFor(() => {
      const select = screen.getByLabelText("ビュー") as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).not.toContain("保護者用月表");
    });

    // On request the settings show it again, marked as off the
    // list; bringing it back restores it to both lists.
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog2 = await screen.findByRole("dialog", { name: "設定・マスタ" });
    const inDialog2 = within(dialog2);
    fireEvent.click(inDialog2.getByRole("button", { name: /一覧から外したビューを表示/ }));
    const archivedRow = () => inDialog2.getByText("保護者用月表").closest("li") as HTMLElement;
    await waitFor(
      () => expect(within(archivedRow()).getByText(/一覧から外しています/)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    fireEvent.click(within(archivedRow()).getByRole("button", { name: "一覧に戻す" }));
    await waitFor(
      () =>
        expect(
          inDialog2.queryByRole("button", { name: /一覧から外したビューを表示/ }),
        ).not.toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(inDialog2.getByText("保護者用月表")).toBeInTheDocument();
    fireEvent.click(inDialog2.getByRole("button", { name: "閉じる" }));
    await waitFor(() => {
      const select = screen.getByLabelText("ビュー") as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toContain("保護者用月表");
    });
  }, 20000);

  it("revoking a public URL asks first, and its issued time is shown in local time", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
    const inDialog = within(dialog);

    // The guardian view's block lists the fixture token, issued
    // 2026-11-01T09:00:00Z on the adapter. The line shows the
    // instant in the reader's zone (lib's conversion, pinned to
    // exact zones in lib.test.ts), not the UTC slice.
    const viewRow = inDialog.getByText("保護者用月表").closest("li") as HTMLElement;
    const expectedIssued = formatIssuedAt("2026-11-01T09:00:00.000Z");
    let tokenRow: HTMLElement | undefined;
    await waitFor(() => {
      tokenRow = [...viewRow.querySelectorAll<HTMLElement>(".public-url-block li")].find((li) =>
        li.textContent?.includes(`${expectedIssued} 発行`),
      );
      expect(tokenRow).toBeDefined();
    });
    const inToken = within(tokenRow as HTMLElement);
    expect(inToken.getByText(/（有効）/)).toBeInTheDocument();

    // The first click only arms the button and spells out that
    // the URL dies for good; the token is still live.
    fireEvent.click(inToken.getByRole("button", { name: "無効化" }));
    expect(inToken.getByRole("button", { name: "本当に無効化" })).toBeInTheDocument();
    expect(inToken.getByText(/無効化すると、この公開URLは使えなくなります/)).toBeInTheDocument();
    expect(inToken.getByText(/（有効）/)).toBeInTheDocument();

    // The second click revokes, and the row says so.
    fireEvent.click(inToken.getByRole("button", { name: "本当に無効化" }));
    await waitFor(() => expect(inToken.queryByText(/に無効化済み/)).toBeInTheDocument());
    expect(inToken.queryByRole("button", { name: "無効化" })).not.toBeInTheDocument();
  }, 20000);

  it("an issued public URL carries only dev=1 from the settings page's query", async () => {
    window.history.pushState({}, "", "/test-school/schedule/?other=1&x=2");
    try {
      render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
      await screen.findByText("開発用小学校");
      fireEvent.click(screen.getByRole("button", { name: "設定" }));
      const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
      const inDialog = within(dialog);
      const viewRow = inDialog.getByText("保護者用月表").closest("li") as HTMLElement;
      const inView = within(viewRow);

      // The settings page's own query (?other=1&x=2) must not
      // leak into a URL the school hands out.
      fireEvent.click(inView.getByRole("button", { name: "公開URLを発行" }));
      const issued = (await inView.findByLabelText("発行した公開URL")) as HTMLInputElement;
      await waitFor(() => expect(issued.value).toContain("/public-view/"));
      expect(issued.value.startsWith(`${window.location.origin}/test-school/schedule/`)).toBe(true);
      expect(issued.value).not.toContain("?");
      expect(issued.value).not.toContain("other");

      // dev=1 — and only dev=1 — rides along, so a development
      // page hands over a URL that opens against the same adapter.
      window.history.pushState({}, "", "/test-school/schedule/?dev=1&other=1");
      fireEvent.click(inView.getByRole("button", { name: "公開URLを発行" }));
      await waitFor(() => expect(issued.value).toContain("?dev=1"));
      expect(issued.value.endsWith("?dev=1")).toBe(true);
      expect(issued.value).not.toContain("other");
    } finally {
      window.history.pushState({}, "", "/");
    }
  }, 20000);

  it("a master added through the relay shows in the masters list", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
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

  it("deleting an item a view uses is refused, headed as a delete on the error line", async () => {
    render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
    const inDialog = within(dialog);

    // 給食 is a column of all five seeded views. The delete is
    // armed, then confirmed; the refusal names the views and the
    // item stays in the list (Issue #88). The error line heads
    // itself after the delete, not after a save (Issue #99);
    // the detail is the server's wording, unchanged.
    const lunchRow = () => inDialog.getByText("給食").closest("li") as HTMLElement;
    fireEvent.click(within(lunchRow()).getByRole("button", { name: "削除" }));
    fireEvent.click(within(lunchRow()).getByRole("button", { name: "本当に削除" }));
    await waitFor(
      () =>
        expect(inDialog.getByRole("alert")).toHaveTextContent(
          "削除できませんでした：この項目はビューで使われているので削除できません（使われているビュー：保護者用月表、職員用カレンダー、職員用年間表、職員用月表、職員用週表（2週間））",
        ),
      { timeout: 5000 },
    );
    expect(inDialog.getByRole("alert").textContent).not.toContain("保存できませんでした");
    expect(inDialog.getByText("給食")).toBeInTheDocument();
  }, 20000);

  it("a settings load that fails is headed as a load, not a save", async () => {
    const base = createDevApi();
    const api: ScheduleApi = {
      ...base,
      getDefinitions: async () => {
        throw new Error("定義の取得に失敗しました");
      },
    };
    render(<App api={api} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
    const inDialog = within(dialog);

    // The panel's first load failed (Issue #99): the error line
    // says the settings could not be read, and the panel stays
    // on its loading line — nothing was read.
    const alert = await inDialog.findByRole("alert");
    expect(alert).toHaveTextContent("読み込めませんでした：定義の取得に失敗しました");
    expect(alert.textContent).not.toContain("保存できませんでした");
    expect(inDialog.getByText("読み込み中…")).toBeInTheDocument();
  }, 20000);

  it("a Viewer sees neither the settings nor the confirmation queue", async () => {
    const api = withRole(createDevApi(), "Viewer", ["view.read", "duty.write"]);
    render(<App api={api} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");
    expect(screen.queryByRole("button", { name: "設定" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "確認待ち" })).not.toBeInTheDocument();
  });
});
