import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { ScheduleApi } from "../src/api";
import { DetailModal } from "../src/DetailModal";
import { createDevApi, DEV_BOOTSTRAP } from "../src/devAdapter";
import type { BootstrapData } from "../src/types";

afterEach(cleanup);

// The detail modal (Issue #37; DESIGN schedule 6.3 / 6.3.1):
// clicking an existing entry opens it, the fields follow the
// entry's kind template, and every field of the record can be
// settled there — the clock dial and direct text entry being two
// hands on the same time (6.4). The development adapter stands
// in for the server, with its in-memory semantics: a write is
// what the next getRange shows.

function withRole(api: ScheduleApi, role: string, permissions: string[]): ScheduleApi {
  return {
    ...api,
    getBootstrap: async (): Promise<BootstrapData> => {
      const bootstrap = await api.getBootstrap();
      return { ...bootstrap, role, permissions };
    },
  };
}

/** Binds a 提出先 text item to the deadline template, the way a
 *  school would in the settings screen (追加項目）. The values
 *  live in this wrapper's own map: the adapter's setEventValues
 *  resolves item definitions against its own fixture, which does
 *  not know the item this wrapper binds. */
function withSubmitItem(api: ScheduleApi): ScheduleApi {
  const values = new Map<string, { itemDefinitionId: string; valueText: string }[]>();
  return {
    ...api,
    getBootstrap: async (): Promise<BootstrapData> => {
      const bootstrap = await api.getBootstrap();
      return {
        ...bootstrap,
        itemDefinitions: [
          ...bootstrap.itemDefinitions,
          {
            id: "item-submit-to",
            key: "submit_to",
            name: "提出先",
            valueType: "text",
            targetGroupId: null,
            targetPlatformAxis: null,
            granularity: "event",
            defaultVisibility: "staff_only",
            sort: 9,
            options: [],
          },
        ],
        kindTemplates: bootstrap.kindTemplates.map((t) =>
          t.key === "deadline" ? { ...t, itemDefinitionIds: ["item-submit-to"] } : t,
        ),
      };
    },
    getEventValues: async (input) =>
      (values.get(input.subjectId) ?? []).map((row, i) => ({
        id: `wrap-v-${i}`,
        itemDefinitionId: row.itemDefinitionId,
        targetId: null,
        targetRef: null,
        valueText: row.valueText,
        valueTime: null,
        valueTimeEnd: null,
        valueNumber: null,
        valueBoolean: null,
        valueOptionId: null,
        valuePersonId: null,
      })),
    setEventValues: async (input) => {
      values.set(
        input.subjectId,
        input.values.map((v) => ({
          itemDefinitionId: v.itemDefinitionId,
          valueText: v.value as string,
        })),
      );
      return [];
    },
  };
}

/** The button that opens an entry's detail modal: the entry's
 *  own line, told apart from the 編集 / 削除 buttons beside it
 *  (their aria-labels carry the entry's text too). */
function entryButton(cell: HTMLElement, text: string): HTMLElement {
  const found = [...cell.querySelectorAll<HTMLElement>("button.entry-open")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(`no entry button for ${text}`);
  return found;
}

/** One cell of the staff month table, by date and column order:
 *  0 行事 / 1 給食 / 2 下校時刻 / 3 バス / 4 清掃 / 5 日番 /
 *  6 〆切 / 7 職員動静. */
function cellFor(date: string, columnIndex: number): HTMLElement {
  const row = document.querySelector(`tr[data-date="${date}"]`);
  if (!row) throw new Error(`no row for ${date}`);
  const cell = row.querySelectorAll("td")[columnIndex];
  if (!cell) throw new Error(`no cell ${columnIndex} for ${date}`);
  return cell as HTMLElement;
}

async function renderApp(api: ScheduleApi) {
  render(<App api={api} initialAnchor="2026-11-15" />);
  await screen.findByText("開発用小学校");
  // The range lands after the bootstrap; wait for the table's rows.
  await waitFor(() => expect(document.querySelector('tr[data-date="2026-11-16"]')).not.toBeNull());
}

async function recordOn(
  api: ScheduleApi,
  date: string,
  kind: "events" | "absences",
  match: (r: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const range = await api.getRange({
    from: "2026-11-01",
    to: "2026-11-30",
    viewId: "view-month-staff",
  });
  const day = range.days.find((d) => d.date === date);
  const found = day?.[kind].find(match);
  if (!found) throw new Error(`record not found on ${date}`);
  return found;
}

describe("the detail modal (Issue #37)", () => {
  it("the fields follow the kind template: a leave has no title and no place", async () => {
    const api = createDevApi();
    await renderApp(api);

    // The leave on 11/13, in the staff-movement column.
    fireEvent.click(
      within(cellFor("2026-11-13", 7)).getByRole("button", { name: "佐藤先生（年休）" }),
    );
    const leave = await screen.findByRole("dialog", { name: "休暇の詳細" });
    expect(within(leave).getByLabelText("取得者")).toHaveValue("teacher-2");
    expect(within(leave).getByLabelText("休暇分類")).toHaveValue("annual");
    expect(within(leave).getByLabelText("メモ")).toBeInTheDocument();
    // No title field, no place, no purpose: 6.3.1's leave form.
    expect(within(leave).queryByLabelText("件名")).not.toBeInTheDocument();
    expect(within(leave).queryByLabelText("場所")).not.toBeInTheDocument();
    expect(within(leave).queryByLabelText("用務")).not.toBeInTheDocument();
    fireEvent.keyDown(leave, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // An event shows the full 6.3 table instead.
    fireEvent.click(within(cellFor("2026-11-06", 0)).getByRole("button", { name: "授業参観" }));
    const event = await screen.findByRole("dialog", { name: "行事の詳細" });
    expect(within(event).getByLabelText("件名")).toHaveValue("授業参観");
    expect(within(event).getByLabelText("場所")).toBeInTheDocument();
    expect(within(event).getByLabelText("登録済みの人から担当者を選ぶ")).toBeInTheDocument();
    expect(within(event).getByLabelText("公開範囲")).toBeInTheDocument();

    // A trip is led by its person and carries its purpose （用務）.
    fireEvent.keyDown(event, { key: "Escape" });
    fireEvent.click(
      within(cellFor("2026-11-20", 7)).getByRole("button", { name: "田中先生 県教研大会" }),
    );
    const trip = await screen.findByRole("dialog", { name: "出張の詳細" });
    expect(within(trip).getByLabelText("出張者")).toHaveValue("teacher-1");
    expect(within(trip).getByLabelText("用務")).toHaveValue("県教研大会");
    expect(within(trip).queryByLabelText("件名")).not.toBeInTheDocument();
  }, 20000);

  it("the clock dial and direct text entry save the same time", async () => {
    const api = createDevApi();
    await renderApp(api);
    const openEvent = async () => {
      fireEvent.click(entryButton(cellFor("2026-11-06", 0), "授業参観"));
      return screen.findByRole("dialog", { name: "行事の詳細" });
    };
    const savedTime = async () =>
      (await recordOn(api, "2026-11-06", "events", (e) => e["title"] === "授業参観"))["time"];

    // Direct text entry: 9:30 typed into the start picker's input.
    let dialog = await openEvent();
    fireEvent.click(within(dialog).getByRole("button", { name: "時刻指定" }));
    const startInput = within(dialog).getByLabelText("開始（直接入力）");
    fireEvent.change(startInput, { target: { value: "9:30" } });
    fireEvent.keyDown(startInput, { key: "Enter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const directTime = await savedTime();
    expect(directTime).toEqual({ kind: "clock", startsAt: "09:30", endsAt: null });

    // Move it away by text, then bring it back with the dial:
    // 午前， 9時, 30分 — the same 09:30 the typing produced.
    // The reopened modal reads the cell's record, so wait until
    // the range reload has landed in the cell's line.
    await waitFor(() =>
      expect(entryButton(cellFor("2026-11-06", 0), "授業参観").textContent).toContain("09:30"),
    );
    dialog = await openEvent();
    const startInput2 = within(dialog).getByLabelText("開始（直接入力）");
    fireEvent.change(startInput2, { target: { value: "14:00" } });
    fireEvent.keyDown(startInput2, { key: "Enter" });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await savedTime()).toEqual({ kind: "clock", startsAt: "14:00", endsAt: null });

    await waitFor(() =>
      expect(entryButton(cellFor("2026-11-06", 0), "授業参観").textContent).toContain("14:00"),
    );
    dialog = await openEvent();
    fireEvent.click(within(dialog).getByRole("button", { name: "開始を時計盤で選ぶ" }));
    // The dial's own 午前 is told apart from the 時間帯 chip of
    // the same name by scoping to the dial box.
    const dialBox = dialog.querySelector(".clock-dial-box");
    if (!dialBox) throw new Error("the dial did not open");
    const dial = within(dialBox as HTMLElement);
    fireEvent.click(dial.getByRole("button", { name: "午前" }));
    fireEvent.click(dial.getByRole("button", { name: "9時" }));
    fireEvent.click(dial.getByRole("button", { name: "30分" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await savedTime()).toEqual(directTime);
  }, 20000);

  it("a time can be given as lesson periods of the day's pattern", async () => {
    const api = createDevApi();
    await renderApp(api);
    fireEvent.click(entryButton(cellFor("2026-11-06", 0), "授業参観"));
    const dialog = await screen.findByRole("dialog", { name: "行事の詳細" });
    fireEvent.click(within(dialog).getByRole("button", { name: "時限指定" }));
    // A click inside the modal must not activate the cell behind
    // it (no inline editor opens under the modal).
    expect(screen.queryByLabelText("行事の入力（2026-11-06）")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("開始時限"), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText("終了時限"), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const record = await recordOn(api, "2026-11-06", "events", (e) => e["title"] === "授業参観");
    expect(record["time"]).toEqual({ kind: "periods", from: 2, to: 3 });
  }, 20000);

  it("a place from the list saves as the location; a typed place stays free text", async () => {
    const api = createDevApi();
    await renderApp(api);
    const openEvent = async () => {
      fireEvent.click(entryButton(cellFor("2026-11-25", 0), "音楽発表会"));
      return screen.findByRole("dialog", { name: "行事の詳細" });
    };
    let dialog = await openEvent();
    fireEvent.change(within(dialog).getByLabelText("場所"), { target: { value: "体育館" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    let record = await recordOn(api, "2026-11-25", "events", (e) => e["title"] === "音楽発表会");
    expect(record["locationId"]).toBe("loc-gym");
    expect(record["locationText"]).toBeNull();

    dialog = await openEvent();
    fireEvent.change(within(dialog).getByLabelText("場所"), { target: { value: "市民会館" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    record = await recordOn(api, "2026-11-25", "events", (e) => e["title"] === "音楽発表会");
    expect(record["locationId"]).toBeNull();
    expect(record["locationText"]).toBe("市民会館");
  }, 20000);

  it("an Editor confirms a tentative entry from the modal; a Viewer is offered no confirmation", async () => {
    const api = createDevApi();
    await renderApp(api);
    // The tentative trip on 11/24 （鈴木先生）.
    fireEvent.click(entryButton(cellFor("2026-11-24", 7), "市教研研修会"));
    const dialog = await screen.findByRole("dialog", { name: "出張の詳細" });
    expect(within(dialog).getByLabelText("確定度")).toHaveValue("tentative");
    fireEvent.click(within(dialog).getByRole("button", { name: "確定する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const confirmed = await recordOn(api, "2026-11-24", "absences", (a) => a["id"] === "abs-3");
    expect(confirmed["certainty"]).toBe("confirmed");
  }, 20000);

  it("a Viewer sees the certainty but no way to change it", async () => {
    const api = withRole(createDevApi(), "Viewer", ["view.read"]);
    await renderApp(api);
    // The Viewer's own trip (teacher-1) on 11/20.
    fireEvent.click(
      within(cellFor("2026-11-20", 7)).getByRole("button", { name: "田中先生 県教研大会" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "出張の詳細" });
    expect(within(dialog).queryByRole("button", { name: "確定する" })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("確定度")).not.toBeInTheDocument();
    expect(within(dialog).getByText("確定")).toBeInTheDocument();
  }, 20000);

  it("the popover's 詳細を開く opens the modal on the new entry", async () => {
    const api = createDevApi();
    await renderApp(api);
    const eventsCell = cellFor("2026-11-16", 0);
    fireEvent.click(eventsCell);
    const input = within(eventsCell).getByLabelText(/行事の入力/);
    fireEvent.change(input, { target: { value: "運動会" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const popover = await screen.findByRole("dialog", { name: "運動会のクイック入力" });
    fireEvent.click(within(popover).getByRole("button", { name: "詳細を開く" }));
    const dialog = await screen.findByRole("dialog", { name: "行事の詳細" });
    expect(within(dialog).getByLabelText("件名")).toHaveValue("運動会");
    expect(screen.queryByRole("dialog", { name: /クイック入力/ })).not.toBeInTheDocument();
  }, 20000);

  it("an entry can be deleted from the modal", async () => {
    const api = createDevApi();
    await renderApp(api);
    fireEvent.click(within(cellFor("2026-11-18", 0)).getByRole("button", { name: "避難訓練" }));
    const dialog = await screen.findByRole("dialog", { name: "行事の詳細" });
    fireEvent.click(within(dialog).getByRole("button", { name: "この予定を削除" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(within(cellFor("2026-11-18", 0)).queryByText("避難訓練")).not.toBeInTheDocument(),
    );
    const range = await api.getRange({
      from: "2026-11-01",
      to: "2026-11-30",
      viewId: "view-month-staff",
    });
    expect(
      range.days
        .find((d) => d.date === "2026-11-18")
        ?.events.some((e) => e["title"] === "避難訓練"),
    ).toBe(false);
  }, 20000);

  it("a kind's bound additional item is edited in the modal and saved as an event value", async () => {
    const api = withSubmitItem(createDevApi());
    await renderApp(api);
    // A deadline typed into its own column; the popover opens and
    // is closed, then the entry itself opens the modal.
    const deadlineCell = cellFor("2026-11-16", 6);
    fireEvent.click(deadlineCell);
    const input = within(deadlineCell).getByLabelText(/〆切の入力/);
    fireEvent.change(input, { target: { value: "成績票提出" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const popover = await screen.findByRole("dialog", { name: "成績票提出のクイック入力" });
    fireEvent.click(within(popover).getByRole("button", { name: "クイック入力を閉じる" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /クイック入力/ })).not.toBeInTheDocument(),
    );
    fireEvent.click(within(deadlineCell).getByRole("button", { name: "成績票提出" }));
    const dialog = await screen.findByRole("dialog", { name: "〆切の詳細" });
    fireEvent.change(within(dialog).getByLabelText("提出先"), { target: { value: "教務部" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const created = await recordOn(api, "2026-11-16", "events", (e) => e["title"] === "成績票提出");
    const values = await api.getEventValues({
      subjectKind: "event",
      subjectId: created["id"] as string,
    });
    expect(values).toHaveLength(1);
    expect(values[0]?.valueText).toBe("教務部");
  }, 20000);

  it("the modal opens on the record as stored: a registered place shows by name", () => {
    const api = createDevApi();
    const template = DEV_BOOTSTRAP.kindTemplates.find((t) => t.key === "event");
    if (!template) throw new Error("no event template");
    render(
      <DetailModal
        target={{
          subjectKind: "event",
          template,
          record: {
            id: "ev-x",
            kind: "event",
            kindLabel: null,
            title: "音楽発表会",
            datePrecision: "day",
            startsOn: "2026-11-25",
            endsOn: "2026-11-25",
            time: { kind: "periods", from: 2, to: 3 },
            locationId: "loc-gym",
            locationText: null,
            description: null,
            certainty: "confirmed",
            visibility: "guardian",
            targets: [],
            impacts: [],
            assignees: [],
            revision: 1,
          },
          date: "2026-11-25",
          dayScheduleId: "pattern-a",
        }}
        bootstrap={DEV_BOOTSTRAP}
        api={api}
        onSaved={() => {}}
        onUnauthorizedError={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText("場所")).toHaveValue("体育館");
    expect(screen.getByLabelText("開始時限")).toHaveValue("2");
    expect(screen.getByLabelText("終了時限")).toHaveValue("3");
  });

  it("a provisional entry opens framed by its kind and stays a provisional when saved", async () => {
    const api = createDevApi();
    await renderApp(api);
    fireEvent.click(within(cellFor("2026-11-19", 7)).getByRole("button", { name: "生徒指導担当" }));
    const dialog = await screen.findByRole("dialog", { name: "出張の詳細" });
    expect(within(dialog).getByLabelText("出張者の名前")).toHaveValue("生徒指導担当");
    fireEvent.change(within(dialog).getByLabelText("メモ"), {
      target: { value: "担当は未定" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const record = await recordOn(
      api,
      "2026-11-19",
      "events",
      (e) => e["id"] === "ev-provisional-name",
    );
    // Still the provisional shape: kind "other", the template's
    // name as its label, the name carried as free text — and the
    // memo landed.
    expect(record["kind"]).toBe("other");
    expect(record["kindLabel"]).toBe("出張");
    expect(record["description"]).toBe("担当は未定");
    expect(within(cellFor("2026-11-19", 7)).getByText("生徒指導担当")).toBeInTheDocument();
  }, 20000);
});
