import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { createDevApi } from "../src/devAdapter";

afterEach(cleanup);

// The absence subdivisions' settings section (Issue #84): an
// Admin maintains the school's classifications — the platform's
// definitions, kept through the relay — and what is saved is
// what the absence modal offers, through the bootstrap the App
// reads again after every save. The development adapter stands
// in for the two servers with the platform's verdicts mirrored:
// a classification an absence still uses cannot be deleted, and
// the refusal is a wording, not a raw error.

function cellFor(date: string, columnIndex: number): HTMLElement {
  const row = document.querySelector(`tr[data-date="${date}"]`);
  if (!row) throw new Error(`no row for ${date}`);
  const cell = row.querySelectorAll("td")[columnIndex];
  if (!cell) throw new Error(`no cell ${columnIndex} for ${date}`);
  return cell as HTMLElement;
}

async function openSettings() {
  render(<App api={createDevApi()} initialAnchor="2026-11-15" />);
  await screen.findByText("開発用小学校");
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  const dialog = await screen.findByRole("dialog", { name: "設定" });
  const inDialog = within(dialog);
  // The section's rows land with the panel's loads.
  await waitFor(() => expect(inDialog.queryByText("年休（キー：annual）")).toBeInTheDocument(), {
    timeout: 5000,
  });
  return { dialog, inDialog };
}

function rowOf(inDialog: ReturnType<typeof within>, text: string): HTMLElement {
  const row = inDialog.getByText(text).closest("li");
  if (!row) throw new Error(`no settings row for ${text}`);
  return row as HTMLElement;
}

describe("absence subdivisions in the settings (Issue #84)", () => {
  it("a classification added and renamed in the settings is offered by the absence modal", async () => {
    const { dialog, inDialog } = await openSettings();

    fireEvent.click(inDialog.getByRole("button", { name: "休暇の分類を追加" }));
    fireEvent.change(inDialog.getByLabelText("分類の名前"), { target: { value: "介護休暇" } });
    fireEvent.change(inDialog.getByLabelText("分類のキー"), { target: { value: "care" } });
    fireEvent.click(inDialog.getByRole("button", { name: "分類を保存" }));
    await waitFor(
      () => expect(inDialog.queryByText("介護休暇（キー：care）")).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    );

    // Rename it: the modal will offer the school's new word.
    fireEvent.click(
      within(rowOf(inDialog, "介護休暇（キー：care）")).getByRole("button", { name: "編集" }),
    );
    fireEvent.change(inDialog.getByLabelText("分類の名前"), {
      target: { value: "介護休暇（家族）" },
    });
    fireEvent.click(inDialog.getByRole("button", { name: "分類を保存" }));
    await waitFor(
      () => expect(inDialog.queryByText("介護休暇（家族）（キー：care）")).toBeInTheDocument(),
      { timeout: 5000 },
    );

    fireEvent.click(inDialog.getByRole("button", { name: "閉じる" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "設定" })).not.toBeInTheDocument(),
    );

    // The leave on 11/13: its classification select now offers
    // the added classification under its renamed label.
    fireEvent.click(
      within(cellFor("2026-11-13", 7)).getByRole("button", { name: "佐藤先生（年休）" }),
    );
    const leave = await screen.findByRole("dialog", { name: "休暇の詳細" });
    const select = within(leave).getByLabelText("休暇分類") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toContain("介護休暇（家族）");
    expect(dialog).not.toBeInTheDocument();
  }, 20000);

  it("an unused classification can be deleted, and a used one stops with the reason", async () => {
    const { inDialog } = await openSettings();

    // 病休 is named by no absence in the fixture: it deletes.
    const sickRow = rowOf(inDialog, "病休（キー：sick）");
    fireEvent.click(within(sickRow).getByRole("button", { name: "削除" }));
    fireEvent.click(within(sickRow).getByRole("button", { name: "本当に削除" }));
    await waitFor(
      () => expect(inDialog.queryByText("病休（キー：sick）")).not.toBeInTheDocument(),
      { timeout: 5000 },
    );

    // 年休 is the leave on 11/13's classification: arming the
    // delete says so, and confirming is refused with the reason
    // in the panel's error line — the row stays.
    const annualRow = rowOf(inDialog, "年休（キー：annual）");
    fireEvent.click(within(annualRow).getByRole("button", { name: "削除" }));
    expect(
      within(annualRow).getByText("使っている不在がある分類は削除できません。"),
    ).toBeInTheDocument();
    fireEvent.click(within(annualRow).getByRole("button", { name: "本当に削除" }));
    await waitFor(
      () =>
        expect(
          inDialog.queryByText(/この分類は不在で使われているため削除できません/),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(inDialog.queryByText("年休（キー：annual）")).toBeInTheDocument();
  }, 20000);

  it("applying the defaults brings back a deleted default classification", async () => {
    const { inDialog } = await openSettings();

    const compensatoryRow = rowOf(inDialog, "振休（キー：compensatory）");
    fireEvent.click(within(compensatoryRow).getByRole("button", { name: "削除" }));
    fireEvent.click(within(compensatoryRow).getByRole("button", { name: "本当に削除" }));
    await waitFor(
      () => expect(inDialog.queryByText("振休（キー：compensatory）")).not.toBeInTheDocument(),
      { timeout: 5000 },
    );

    fireEvent.click(inDialog.getByRole("button", { name: "既定の休暇分類を入れる" }));
    await waitFor(
      () => expect(inDialog.queryByText("振休（キー：compensatory）")).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(inDialog.getByText("既定の休暇分類を1件入れました")).toBeInTheDocument();

    // And with every default in place, the same button says so.
    fireEvent.click(inDialog.getByRole("button", { name: "既定の休暇分類を入れる" }));
    await waitFor(
      () => expect(inDialog.queryByText("既定の休暇分類はすでに入っています")).toBeInTheDocument(),
      { timeout: 5000 },
    );
  }, 20000);
});
