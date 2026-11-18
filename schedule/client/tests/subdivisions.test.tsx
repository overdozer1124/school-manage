import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { ScheduleApi } from "../src/api";
import { createDevApi } from "../src/devAdapter";

afterEach(cleanup);

// The absence subdivisions' settings section (Issue #84): an
// Admin maintains the school's classifications — the platform's
// definitions, kept through the relay — and what is saved is
// what the absence modal offers, through the bootstrap the App
// reads again after every save. The development adapter stands
// in for the two servers with the platform's verdicts mirrored:
// a classification an absence still uses cannot be deleted, and
// the refusal is a wording, not a raw error. An existing
// classification's key cannot change either — absences name
// their classification by key, so the form offers the key only
// when adding, and the adapter refuses a changed key outright.

function cellFor(date: string, columnIndex: number): HTMLElement {
  const row = document.querySelector(`tr[data-date="${date}"]`);
  if (!row) throw new Error(`no row for ${date}`);
  const cell = row.querySelectorAll("td")[columnIndex];
  if (!cell) throw new Error(`no cell ${columnIndex} for ${date}`);
  return cell as HTMLElement;
}

async function openSettings(api: ScheduleApi = createDevApi()) {
  render(<App api={api} initialAnchor="2026-11-15" />);
  await screen.findByText("開発用小学校");
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  const dialog = await screen.findByRole("dialog", { name: "設定・マスタ" });
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
      expect(screen.queryByRole("dialog", { name: "設定・マスタ" })).not.toBeInTheDocument(),
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

  it("an existing classification's key cannot be changed in the edit form", async () => {
    const { inDialog } = await openSettings();

    fireEvent.click(
      within(rowOf(inDialog, "年休（キー：annual）")).getByRole("button", { name: "編集" }),
    );
    const keyInput = inDialog.getByLabelText("分類のキー") as HTMLInputElement;
    expect(keyInput).toBeDisabled();
    expect(keyInput.value).toBe("annual");

    // The name still edits, and the saved row keeps its key.
    fireEvent.change(inDialog.getByLabelText("分類の名前"), {
      target: { value: "年次休暇" },
    });
    fireEvent.click(inDialog.getByRole("button", { name: "分類を保存" }));
    await waitFor(
      () => expect(inDialog.queryByText("年次休暇（キー：annual）")).toBeInTheDocument(),
      { timeout: 5000 },
    );
  }, 20000);

  it("the development adapter refuses a key change on an existing classification", async () => {
    const api = createDevApi();
    const { items } = await api.getSubdivisions();
    const annual = items.find((s) => s.key === "annual");
    if (!annual) throw new Error("no annual subdivision in the fixture");
    await expect(
      api.updateSubdivision({ id: annual.id, record: { ...annual, key: "nenkyu" } }),
    ).rejects.toThrow("すでにある分類のキーは変更できません");

    // A name-only update still goes through, key untouched.
    const renamed = await api.updateSubdivision({
      id: annual.id,
      record: { ...annual, label: "年次休暇" },
    });
    expect(renamed.label).toBe("年次休暇");
    expect(renamed.key).toBe("annual");
  });

  it("moving a classification in the settings reorders the modal's choices (Issue #91)", async () => {
    const { inDialog } = await openSettings();

    const rowLabels = () =>
      [
        ...inDialog.getByText("休暇", { selector: "h4" }).closest("div")!.querySelectorAll("li"),
      ].map((li) => li.querySelector("span")?.textContent);
    // The shipped order is the school's reading order, not the
    // key's: その他 is last.
    expect(rowLabels()).toEqual([
      "年休（キー：annual）",
      "特休（キー：special）",
      "夏特（キー：summer_special）",
      "病休（キー：sick）",
      "看護（キー：nursing）",
      "振休（キー：compensatory）",
      "職専免（キー：duty_exempt）",
      "その他（キー：other）",
    ]);

    // The first row cannot move up; moving 年休 down swaps it
    // with 特休.
    const annualRow = rowOf(inDialog, "年休（キー：annual）");
    expect(within(annualRow).getByRole("button", { name: "上へ" })).toBeDisabled();
    fireEvent.click(within(annualRow).getByRole("button", { name: "下へ" }));
    await waitFor(() => expect(rowLabels()[0]).toBe("特休（キー：special）"), { timeout: 5000 });
    expect(rowLabels()[1]).toBe("年休（キー：annual）");

    fireEvent.click(inDialog.getByRole("button", { name: "閉じる" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "設定・マスタ" })).not.toBeInTheDocument(),
    );

    // The absence modal offers the classifications in the new
    // order.
    fireEvent.click(
      within(cellFor("2026-11-13", 7)).getByRole("button", { name: "佐藤先生（年休）" }),
    );
    const leave = await screen.findByRole("dialog", { name: "休暇の詳細" });
    const select = within(leave).getByLabelText("休暇分類") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual([
      "（なし）",
      "特休",
      "年休",
      "夏特",
      "病休",
      "看護",
      "振休",
      "職専免",
      "その他",
    ]);
  }, 20000);

  it("the development adapter appends a classification created without a sort (Issue #91)", async () => {
    const api = createDevApi();
    const created = await api.createSubdivision({
      record: { id: "subdiv-care", code: "leave", key: "care", label: "介護休暇" },
    });
    expect(created.sort).toBe(90);
    const { items } = await api.getSubdivisions();
    expect(items[items.length - 1]?.key).toBe("care");
    // And a rename that sends no sort keeps the stored one.
    const renamed = await api.updateSubdivision({
      id: "subdiv-care",
      record: { ...created, label: "介護休暇（家族）" },
    });
    expect(renamed.sort).toBe(90);
  });

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

// A reorder whose save fails part-way (Issue #98): the rows
// before the failure are already saved, with new numbers and
// revisions, so the section reads the list back even on
// failure — the screen shows what is actually stored, and the
// next move sends the stored revisions instead of failing
// again on the stale ones it would otherwise still hold.

/** The development adapter with another admin at work: the
 *  second subdivision save finds its row already saved by
 *  someone else (the same record written back, revision moved
 *  on), so the save's revision no longer matches and the
 *  adapter refuses it the platform's way. The first row's
 *  save, though, has already landed. */
function apiWithConcurrentSave(): ScheduleApi {
  const base = createDevApi();
  let saves = 0;
  return {
    ...base,
    async updateSubdivision(input) {
      saves += 1;
      if (saves === 2) {
        const { items } = await base.getSubdivisions();
        const current = items.find((s) => s.id === input.id);
        if (current) {
          await base.updateSubdivision({ id: current.id, record: { ...current } });
        }
      }
      return base.updateSubdivision(input);
    },
  };
}

/** The second save fails, and the re-read behind it fails
 *  too: the error line must still show the save's error, not
 *  the re-read's. */
function apiWithFailingSaveAndRead(): ScheduleApi {
  const base = createDevApi();
  let saves = 0;
  let readFails = false;
  return {
    ...base,
    async getSubdivisions() {
      if (readFails) throw new Error("分類を読み直せませんでした");
      return base.getSubdivisions();
    },
    async updateSubdivision(input) {
      saves += 1;
      if (saves === 2) {
        readFails = true;
        throw new Error("ほかの人が先に変更しました");
      }
      return base.updateSubdivision(input);
    },
  };
}

describe("a reorder save that fails part-way (Issue #98)", () => {
  function leaveRowLabels(inDialog: ReturnType<typeof within>): (string | undefined)[] {
    return [
      ...inDialog.getByText("休暇", { selector: "h4" }).closest("div")!.querySelectorAll("li"),
    ].map((li) => li.querySelector("span")?.textContent);
  }

  it("a move whose second save fails leaves the list showing the saved state, with the error", async () => {
    const api = apiWithConcurrentSave();
    const { inDialog } = await openSettings(api);

    // 病休 down: 看護 is saved first with its new number 40,
    // then 病休's save is refused — its revision has moved on.
    fireEvent.click(
      within(rowOf(inDialog, "病休（キー：sick）")).getByRole("button", { name: "下へ" }),
    );
    await waitFor(
      () => expect(inDialog.queryByText(/ほかの人が先に変更しました/)).toBeInTheDocument(),
      { timeout: 5000 },
    );

    // The list was read back: it shows what is actually
    // saved. 看護 carries its new number 40, level with
    // 病休's 40, and the key order puts 看護 first — the
    // swap the first save landed is the one on screen.
    await waitFor(
      () =>
        expect(leaveRowLabels(inDialog)).toEqual([
          "年休（キー：annual）",
          "特休（キー：special）",
          "夏特（キー：summer_special）",
          "看護（キー：nursing）",
          "病休（キー：sick）",
          "振休（キー：compensatory）",
          "職専免（キー：duty_exempt）",
          "その他（キー：other）",
        ]),
      { timeout: 5000 },
    );
    const { items } = await api.getSubdivisions();
    expect(items.find((s) => s.key === "nursing")).toMatchObject({ sort: 40, revision: 2 });
    expect(items.find((s) => s.key === "sick")).toMatchObject({ sort: 40, revision: 2 });
  }, 20000);

  it("moving again after the failed move works, on the refreshed revisions", async () => {
    const api = apiWithConcurrentSave();
    const { inDialog } = await openSettings(api);

    fireEvent.click(
      within(rowOf(inDialog, "病休（キー：sick）")).getByRole("button", { name: "下へ" }),
    );
    await waitFor(
      () => expect(inDialog.queryByText(/ほかの人が先に変更しました/)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    await waitFor(() => expect(leaveRowLabels(inDialog)[3]).toBe("看護（キー：nursing）"), {
      timeout: 5000,
    });

    // 看護 down puts it back below 病休. Its save sends the
    // revision the re-read brought in, so it goes through —
    // on the stale revision the section held before the
    // re-read, it would be refused the same way again.
    fireEvent.click(
      within(rowOf(inDialog, "看護（キー：nursing）")).getByRole("button", { name: "下へ" }),
    );
    await waitFor(() => expect(leaveRowLabels(inDialog)[3]).toBe("病休（キー：sick）"), {
      timeout: 5000,
    });
    expect(leaveRowLabels(inDialog)[4]).toBe("看護（キー：nursing）");
    expect(inDialog.queryByText(/ほかの人が先に変更しました/)).not.toBeInTheDocument();
  }, 20000);

  it("a re-read that fails after the failed save still shows the save's error", async () => {
    const api = apiWithFailingSaveAndRead();
    const { inDialog } = await openSettings(api);

    fireEvent.click(
      within(rowOf(inDialog, "病休（キー：sick）")).getByRole("button", { name: "下へ" }),
    );
    await waitFor(
      () =>
        expect(
          inDialog.queryByText("保存できませんでした：ほかの人が先に変更しました"),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(inDialog.queryByText(/分類を読み直せませんでした/)).not.toBeInTheDocument();
  }, 20000);
});
