import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
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
    const dialog = await screen.findByRole("dialog", { name: "発行と印刷" });
    const inDialog = within(dialog);
    expect(inDialog.getByText("まだ発行されていません。")).toBeInTheDocument();

    fireEvent.change(inDialog.getByLabelText("版ラベル"), {
      target: { value: "11月18日修正" },
    });
    fireEvent.click(inDialog.getByRole("button", { name: "発行する" }));

    expect(await inDialog.findByText("「11月18日修正」を発行しました")).toBeInTheDocument();
    const item = inDialog.getByText("11月18日修正").closest("li") as HTMLElement;
    fireEvent.click(within(item).getByRole("button", { name: "プレビュー" }));

    const frame = (await inDialog.findByTitle("印刷プレビュー")) as HTMLIFrameElement;
    await waitFor(() => expect(frame.srcdoc).toContain("授業参観"));
    expect(frame.srcdoc).toContain("版：11月18日修正");
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
        anchor="2026-11-15"
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
    expect(list.map((p) => p.versionLabel)).toEqual(["第2版", "第1版"]);
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
