import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { ScheduleApi } from "../src/api";
import { createDevApi, DEV_BOOTSTRAP } from "../src/devAdapter";
import { PublishPanel } from "../src/PublishPanel";
import type { BootstrapData } from "../src/types";

afterEach(cleanup);

// Publishing (Issue #40, DESIGN schedule 9.1): a month table is
// issued as a versioned document, the issued document is stored
// and never changes, and a guardian view's document carries no
// staff-only items, duties or names. The dev adapter builds its
// documents from its own fixture range, under the same audience
// rules as the server.

describe("publishing panel (Issue #40)", () => {
  it("issues a version, lists it, and previews the stored document", async () => {
    const api = createDevApi();
    render(<App api={api} initialAnchor="2026-11-15" />);
    await screen.findByText("開発用小学校");

    fireEvent.click(screen.getByRole("button", { name: "発行・印刷" }));
    const dialog = await screen.findByRole("dialog", { name: /発行・印刷（/ });
    const inDialog = within(dialog);
    // The adapter seeds a version history (Issue #48); a month
    // with nothing issued yet shows the empty face.
    fireEvent.change(inDialog.getByLabelText("月で絞り込む"), {
      target: { value: "2026-12" },
    });
    expect(await inDialog.findByText("その月はまだ発行されていません。")).toBeInTheDocument();
    fireEvent.click(inDialog.getByRole("button", { name: "絞り込みをやめる" }));
    expect(await inDialog.findByText("11月10日版")).toBeInTheDocument();

    fireEvent.change(inDialog.getByLabelText("版ラベル"), {
      target: { value: "11月20日修正" },
    });
    fireEvent.click(inDialog.getByRole("button", { name: "発行する" }));

    expect(await inDialog.findByText("「11月20日修正」を発行しました")).toBeInTheDocument();
    const item = inDialog.getByText("11月20日修正").closest("li") as HTMLElement;
    fireEvent.click(within(item).getByRole("button", { name: "プレビュー" }));

    const frame = (await inDialog.findByTitle("印刷プレビュー")) as HTMLIFrameElement;
    // The preview is display-only: the frame is sandboxed, so
    // nothing in the stored document can run a script or reach
    // the app's origin (PR #79 review, recommendation 1).
    expect(frame.getAttribute("sandbox")).toBe("");
    await waitFor(() => expect(frame.srcdoc).toContain("授業参観"));
    expect(frame.srcdoc).toContain("版：11月20日修正");
    expect(frame.srcdoc).toContain("size: A4 landscape");
  });

  it("a Viewer gets the list and preview, but no publish form", async () => {
    const api = createDevApi();
    await api.createPublication({
      viewId: "view-month-staff",
      targetMonth: "2026-11",
      versionLabel: "先週配った版",
    });
    const viewerBootstrap: BootstrapData = {
      ...structuredClone(DEV_BOOTSTRAP),
      role: "Viewer",
      permissions: ["view.read"],
    };
    render(
      <PublishPanel
        bootstrap={viewerBootstrap}
        api={api}
        view={viewerBootstrap.views[0] as BootstrapData["views"][number]}
        period={{ from: "2026-11-01", to: "2026-11-30" }}
        periodLabel="2026年11月"
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("先週配った版")).toBeInTheDocument();
    expect(screen.queryByLabelText("版ラベル")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "発行する" })).not.toBeInTheDocument();
  });
});

describe("dev adapter publications (Issue #40)", () => {
  it("a guardian document has no staff-only items, duties or names", async () => {
    const api = createDevApi();
    const meta = await api.createPublication({
      viewId: "view-month-guardian",
      targetMonth: "2026-11",
      versionLabel: "保護者版",
    });
    const doc = await api.getPublication({ id: meta.id });
    expect(doc.documentHtml).toContain("授業参観");
    // The fixture's absences and duty holders are staff dynamics.
    expect(doc.documentHtml).not.toContain("佐藤先生");
    expect(doc.documentHtml).not.toContain("田中先生");
    expect(doc.documentHtml).not.toContain("鈴木先生");
    expect(doc.documentHtml).not.toContain("年休");
    expect(doc.documentHtml).not.toContain("生徒指導担当");
  });

  it("an issued document does not change when the data does", async () => {
    const api = createDevApi();
    const first = await api.createPublication({
      viewId: "view-month-staff",
      targetMonth: "2026-11",
      versionLabel: "第1版",
    });
    const issued = await api.getPublication({ id: first.id });
    expect(issued.documentHtml).toContain("授業参観");
    expect(issued.documentHtml).not.toContain("文化祭");

    await api.createEvent({
      event: {
        id: "ev-bunkasai",
        kind: "event",
        kindLabel: null,
        title: "文化祭",
        datePrecision: "day",
        startsOn: "2026-11-21",
        endsOn: "2026-11-21",
        certainty: "confirmed",
        visibility: "guardian",
        targets: [],
        impacts: [],
        assignees: [],
      },
    });

    const reread = await api.getPublication({ id: first.id });
    expect(reread.documentHtml).toBe(issued.documentHtml);

    const second = await api.createPublication({
      viewId: "view-month-staff",
      targetMonth: "2026-11",
      versionLabel: "第2版",
    });
    const secondDoc = await api.getPublication({ id: second.id });
    expect(secondDoc.documentHtml).toContain("文化祭");

    const list = await api.getPublications({ viewId: "view-month-staff" });
    // The two new versions lead; the seeded history (Issue #48)
    // follows, newest first.
    expect(list.map((p) => p.versionLabel)).toEqual([
      "第2版",
      "第1版",
      "11月18日修正",
      "11月10日版",
      "10月5日版",
    ]);
  });

  it("print settings resolve view first, then the publisher's choice", async () => {
    const api = createDevApi();
    const meta = await api.createPublication({
      viewId: "view-month-staff",
      targetMonth: "2026-11",
      versionLabel: "A3版",
      printSettings: { paper: "A3", orientation: "portrait" },
    });
    expect(meta.printSettings).toEqual({
      paper: "A3",
      orientation: "portrait",
      marginMm: 10,
      fontScale: "medium",
    });
    const doc = await api.getPublication({ id: meta.id });
    expect(doc.documentHtml).toContain("size: A3 portrait");
  });
});

// The version history (Issue #48): the panel lists the seeded
// history with its cancelled version badged, filters it by
// month, corrects a label and note in place, cancels after a
// confirmation, and reads one version against the previous
// one — the changed days only.

function renderPanel(api: ReturnType<typeof createDevApi>) {
  const bootstrap = structuredClone(DEV_BOOTSTRAP);
  render(
    <PublishPanel
      bootstrap={bootstrap}
      api={api}
      view={bootstrap.views[0] as BootstrapData["views"][number]}
      period={{ from: "2026-11-01", to: "2026-11-30" }}
      periodLabel="2026年11月"
      onClose={() => undefined}
    />,
  );
}

describe("publishing panel version history (Issue #48)", () => {
  it("lists the seeded history with the cancelled badge, and filters by month", async () => {
    const api = createDevApi();
    renderPanel(api);
    expect(await screen.findByText("11月10日版")).toBeInTheDocument();
    expect(screen.getByText("11月18日修正")).toBeInTheDocument();
    const octoberRow = screen.getByText("10月5日版").closest("li") as HTMLElement;
    expect(within(octoberRow).getByText("取り消し")).toBeInTheDocument();
    // A cancelled row offers neither edit nor cancel.
    expect(
      within(octoberRow).queryByRole("button", { name: "ラベル・メモを編集" }),
    ).not.toBeInTheDocument();
    expect(within(octoberRow).queryByRole("button", { name: "取り消す" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("月で絞り込む"), {
      target: { value: "2026-10" },
    });
    await waitFor(() => expect(screen.queryByText("11月10日版")).not.toBeInTheDocument());
    expect(screen.getByText("10月5日版")).toBeInTheDocument();
  });

  it("shows the diff against the previous version, changed days only", async () => {
    const api = createDevApi();
    renderPanel(api);
    const secondRow = (await screen.findByText("11月18日修正")).closest("li") as HTMLElement;
    fireEvent.click(within(secondRow).getByRole("button", { name: "前の版との違い" }));
    expect(await screen.findByText("前の版との違い（11月18日修正）")).toBeInTheDocument();
    expect(screen.getByText("2026年11月19日")).toBeInTheDocument();
    const cellLine = screen.getByText(/給食：/);
    expect(cellLine.textContent).toContain("○");
    expect(cellLine.textContent).toContain("×");
    // The one changed day is listed; its unchanged neighbours
    // are not.
    expect(screen.queryByText("2026年11月21日")).not.toBeInTheDocument();
    expect(screen.queryByText("2026年11月18日")).not.toBeInTheDocument();

    const firstRow = screen.getByText("11月10日版").closest("li") as HTMLElement;
    fireEvent.click(within(firstRow).getByRole("button", { name: "前の版との違い" }));
    expect(await screen.findByText("前の版がありません")).toBeInTheDocument();
  });

  it("edits a version's label and note through updatePublication", async () => {
    const api = createDevApi();
    const update = vi.spyOn(api, "updatePublication");
    renderPanel(api);
    const row = (await screen.findByText("11月10日版")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "ラベル・メモを編集" }));
    fireEvent.change(within(row).getByLabelText("版ラベル（編集）"), {
      target: { value: "11月10日版・訂正" },
    });
    fireEvent.change(within(row).getByLabelText("メモ（編集）"), {
      target: { value: "訂正メモ" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "保存する" }));
    expect(
      await screen.findByText("「11月10日版・訂正」のラベルとメモを直しました"),
    ).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith({
      id: "pub-seed-nov-1",
      versionLabel: "11月10日版・訂正",
      note: "訂正メモ",
    });
    expect(screen.getByText("11月10日版・訂正")).toBeInTheDocument();
  });

  it("cancels a version after confirming, and the row stays badged", async () => {
    const api = createDevApi();
    renderPanel(api);
    const row = (await screen.findByText("11月10日版")).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "取り消す" }));
    expect(within(row).getByText("取り消しますか？")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "取り消す" }));
    expect(await screen.findByText("「11月10日版」を取り消しました")).toBeInTheDocument();
    const updatedRow = screen.getByText("11月10日版").closest("li") as HTMLElement;
    expect(within(updatedRow).getByText("取り消し")).toBeInTheDocument();
    expect(
      within(updatedRow).queryByRole("button", { name: "ラベル・メモを編集" }),
    ).not.toBeInTheDocument();
    expect(within(updatedRow).queryByRole("button", { name: "取り消す" })).not.toBeInTheDocument();
  });
});

describe("dev adapter version history (Issue #48)", () => {
  it("filters the list by month", async () => {
    const api = createDevApi();
    const november = await api.getPublications({
      viewId: "view-month-staff",
      targetMonth: "2026-11",
    });
    expect(november.map((p) => p.versionLabel)).toEqual(["11月18日修正", "11月10日版"]);
    const october = await api.getPublications({
      viewId: "view-month-staff",
      targetMonth: "2026-10",
    });
    expect(october.map((p) => p.versionLabel)).toEqual(["10月5日版"]);
    expect(october[0]?.cancelledAt).not.toBeNull();
  });

  it("diffs the seeded versions on the one changed cell", async () => {
    const api = createDevApi();
    const diff = await api.getPublicationDiff({ id: "pub-seed-nov-2" });
    expect(diff).toEqual({
      comparable: true,
      fromId: "pub-seed-nov-1",
      toId: "pub-seed-nov-2",
      changes: [
        {
          date: "2026-11-19",
          cells: [{ columnId: "view-month-staff-lunch", label: "給食", before: "○", after: "×" }],
        },
      ],
    });
    const first = await api.getPublicationDiff({ id: "pub-seed-nov-1" });
    expect(first.comparable).toBe(true);
    expect(first.fromId).toBeNull();
  });

  it("refuses to edit or re-cancel the cancelled seed", async () => {
    const api = createDevApi();
    await expect(
      api.updatePublication({ id: "pub-seed-oct-1", versionLabel: "訂正" }),
    ).rejects.toThrow(/取り消した版/);
    await expect(api.cancelPublication({ id: "pub-seed-oct-1" })).rejects.toThrow(
      /すでに取り消されています/,
    );
    const cancelled = await api.cancelPublication({ id: "pub-seed-nov-1" });
    expect(cancelled.cancelledAt).not.toBeNull();
    await expect(api.cancelPublication({ id: "pub-seed-nov-1" })).rejects.toThrow(
      /すでに取り消されています/,
    );
  });

  it("a version published in the adapter diffs against the previous one", async () => {
    const api = createDevApi();
    const created = await api.createPublication({
      viewId: "view-month-staff",
      targetMonth: "2026-11",
      versionLabel: "新しい版",
    });
    const diff = await api.getPublicationDiff({ id: created.id });
    expect(diff.comparable).toBe(true);
    expect(diff.fromId).toBe("pub-seed-nov-2");
  });
});

// The other layouts issue (Issue #49): the panel is handed the
// period the screen shows — a year table's school year, a
// calendar's month — sends it with the publish, and the dev
// adapter renders each layout's paper form: the week table
// headed by its span, the year table as twelve month blocks,
// the calendar printing every entry of a crowded day (the
// screen cell caps at three and counts the rest as 「他○件」;
// paper cannot be clicked, so nothing is capped).

describe("publishing panel for the other layouts (Issue #49)", () => {
  it("publishes a year view with the school-year span", async () => {
    const base = createDevApi();
    const calls: Record<string, unknown>[] = [];
    const api: ScheduleApi = {
      ...base,
      createPublication: async (input) => {
        calls.push(input);
        return base.createPublication(input);
      },
    };
    const bootstrap = structuredClone(DEV_BOOTSTRAP);
    const view = bootstrap.views.find(
      (v) => v.id === "view-year-staff",
    ) as BootstrapData["views"][number];
    render(
      <PublishPanel
        bootstrap={bootstrap}
        api={api}
        view={view}
        period={{ from: "2026-04-01", to: "2027-03-31" }}
        periodLabel="2026年度"
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("2026年度の新しい版を発行")).toBeInTheDocument();
    // The year table's default paper stands in the form (A3,
    // the layout default of Issue #49).
    expect(screen.getByLabelText("用紙")).toHaveValue("A3");
    expect(screen.getByLabelText("向き")).toHaveValue("landscape");

    fireEvent.change(screen.getByLabelText("版ラベル"), { target: { value: "年度版" } });
    fireEvent.click(screen.getByRole("button", { name: "発行する" }));
    expect(await screen.findByText("「年度版」を発行しました")).toBeInTheDocument();
    expect(calls).toEqual([
      expect.objectContaining({
        viewId: "view-year-staff",
        targetMonth: "2026-04",
        from: "2026-04-01",
        to: "2027-03-31",
      }),
    ]);
    const pubs = await base.getPublications({ viewId: "view-year-staff" });
    expect(pubs[0]).toMatchObject({ rangeFrom: "2026-04-01", rangeTo: "2027-03-31" });
    // The history row names the school year, not a month.
    const row = screen.getByText("年度版").closest("li") as HTMLElement;
    expect(within(row).getByText(/2026年度・/)).toBeInTheDocument();
  });

  it("publishes a calendar view with the month span and portrait defaults", async () => {
    const base = createDevApi();
    const calls: Record<string, unknown>[] = [];
    const api: ScheduleApi = {
      ...base,
      createPublication: async (input) => {
        calls.push(input);
        return base.createPublication(input);
      },
    };
    const bootstrap = structuredClone(DEV_BOOTSTRAP);
    const view = bootstrap.views.find(
      (v) => v.id === "view-calendar-staff",
    ) as BootstrapData["views"][number];
    render(
      <PublishPanel
        bootstrap={bootstrap}
        api={api}
        view={view}
        period={{ from: "2026-11-01", to: "2026-11-30" }}
        periodLabel="2026年11月"
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("2026年11月の新しい版を発行")).toBeInTheDocument();
    // The calendar's default paper: A4 portrait (Issue #49).
    expect(screen.getByLabelText("用紙")).toHaveValue("A4");
    expect(screen.getByLabelText("向き")).toHaveValue("portrait");

    fireEvent.change(screen.getByLabelText("版ラベル"), { target: { value: "カレンダー版" } });
    fireEvent.click(screen.getByRole("button", { name: "発行する" }));
    expect(await screen.findByText("「カレンダー版」を発行しました")).toBeInTheDocument();
    expect(calls).toEqual([
      expect.objectContaining({
        viewId: "view-calendar-staff",
        targetMonth: "2026-11",
        from: "2026-11-01",
        to: "2026-11-30",
      }),
    ]);
  });
});

describe("dev adapter documents for the other layouts (Issue #49)", () => {
  it("renders the week, year and calendar paper forms", async () => {
    const api = createDevApi();

    // The week table (a 14-day span): headed by the span, with
    // the span's fourteen rows.
    const week = await api.createPublication({
      viewId: "view-week-staff",
      targetMonth: "2026-11",
      from: "2026-11-09",
      to: "2026-11-22",
      versionLabel: "2週間版",
    });
    expect(week).toMatchObject({ rangeFrom: "2026-11-09", rangeTo: "2026-11-22" });
    const weekDoc = await api.getPublication({ id: week.id });
    expect(weekDoc.documentHtml).toContain("2026年11月9日〜11月22日 行事予定表");
    const weekBody = (weekDoc.documentHtml.split("<tbody>")[1] ?? "").split(
      "</tbody>",
    )[0] as string;
    expect(weekBody.match(/<tr/g)).toHaveLength(14);
    expect(weekDoc.documentHtml).toContain("マラソン大会");

    // The year table: twelve month blocks and the year's
    // entries, on A3 landscape.
    const year = await api.createPublication({
      viewId: "view-year-staff",
      targetMonth: "2026-04",
      from: "2026-04-01",
      to: "2027-03-31",
      versionLabel: "年度版",
    });
    const yearDoc = await api.getPublication({ id: year.id });
    expect(yearDoc.documentHtml).toContain("2026年度 行事予定表");
    for (const m of [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3]) {
      expect(yearDoc.documentHtml).toContain(`>${m}月</th>`);
    }
    expect(yearDoc.documentHtml).toContain("音楽発表会");
    expect(yearDoc.documentHtml).toContain("size: A3 landscape");

    // The month calendar: 2026-11-16 holds more entries than
    // the screen cell's cap of three (朝会・打ち合わせ・職員
    // 会議 and 田中先生's leave) — the document prints them
    // all, and no overflow count appears.
    const cal = await api.createPublication({
      viewId: "view-calendar-staff",
      targetMonth: "2026-11",
      versionLabel: "カレンダー版",
    });
    expect(cal).toMatchObject({ rangeFrom: "2026-11-01", rangeTo: "2026-11-30" });
    const calDoc = await api.getPublication({ id: cal.id });
    expect(calDoc.documentHtml).toContain("朝会");
    expect(calDoc.documentHtml).toContain("打ち合わせ");
    expect(calDoc.documentHtml).toContain("職員会議");
    // The leave's own line — 田中先生（年休）, the absence line
    // of 2026-11-16 — not just the name, which the 20th's trip
    // （田中先生 県教研大会） would satisfy on its own, and not
    // just 年休, which 佐藤先生's leaves would satisfy.
    expect(calDoc.documentHtml).toContain("田中先生（年休）");
    expect(calDoc.documentHtml).not.toMatch(/他\d+件/);
    expect(calDoc.documentHtml).toContain("size: A4 portrait");
    // The 16th's own cell carries all four of its entries —
    // the three timed events and the leave the screen cell
    // caps away — plus the compact lunch line the grid shows.
    const cell16 =
      calDoc.documentHtml
        .split('<td class="cal-cell')
        .find((cell) => cell.includes('cal-date">16<')) ?? "";
    for (const line of ["朝会", "打ち合わせ", "職員会議", "田中先生（年休）", "給食：○"]) {
      expect(cell16).toContain(line);
    }
  });

  it("refuses the screen-only layouts and broken spans, as the server does", async () => {
    const api = createDevApi();
    await expect(
      api.createPublication({
        viewId: "view-year-staff",
        targetMonth: "2026-11",
        from: "2026-11-01",
        to: "2026-11-30",
        versionLabel: "だめな版",
      }),
    ).rejects.toThrow(/年間表の発行期間は/);
    await expect(
      api.createPublication({
        viewId: "view-week-staff",
        targetMonth: "2026-11",
        from: "2026-11-09",
        to: "2026-11-13",
        versionLabel: "だめな版",
      }),
    ).rejects.toThrow(/週表の発行期間は/);
  });
});
